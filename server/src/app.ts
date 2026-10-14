import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import jwt from "jsonwebtoken";
import { hash, compare } from "bcryptjs";
import { z } from "zod";
import { type Pool, transaction } from "./db.js";
import type { Config } from "./config.js";
import { HttpError } from "./errors.js";
import { EgressPolicy } from "./egress.js";
import { encrypt, decrypt } from "./crypto.js";
import { smtpSchema, telegramSchema, telegramValidate, telegramSummary, type TelegramValidate } from "./notifications.js";
import { Storage } from "./storage.js";
import { stepsSchema } from "./browser-steps.js";
import { vaultSchema, sealValues } from "./vault.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { previewRegion, releaseRegionPreviewSession, type PreviewStage, type RegionPreviewFailure } from "./region-picker.js";
import { previewJinaText } from "./text-picker.js";
import pino from "pino";
import { Decimal } from "decimal.js";
import path from "node:path";
import { acquireChromiumLease } from "./chromium-capacity.js";
const uuid = z.string().uuid();
const threshold = z
  .union([
    z.string().regex(/^(?:\d{1,3})(?:\.\d{1,10})?$/),
    z.number().finite(),
  ])
  .transform(String)
  .refine(
    (n) =>
      Number(n) >= 0 &&
      Number(n) <= 100 &&
      new Decimal(n).decimalPlaces() <= 10,
  );
const monitorInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    url: z.string().url().max(2048),
    kind: z.enum(["browser", "html", "api"]).default("browser"),
    text_enabled: z.boolean().default(true),
    text_direction: z.enum(["added", "removed", "both"]).default("both"),
    text_source: z.enum(["direct", "jina"]).default("direct"),
    extraction_mode: z.enum(["full_text", "selected_text"]).default("full_text"),
    extraction_rule: z.union([
      z.object({
        version: z.literal(1), kind: z.literal("bounded_context"),
        before: z.string().max(160), after: z.string().max(160),
        max_length: z.number().int().min(1).max(500),
      }).strict(),
      z.object({
        version: z.literal(2), kind: z.literal("anchored_lines"),
        anchors: z.array(z.object({ text: z.string().min(1).max(160), offset: z.union([z.literal(-2), z.literal(-1), z.literal(1), z.literal(2)]) }).strict()).min(2).max(4),
        prefix: z.string().max(160), suffix: z.string().max(160),
        max_length: z.number().int().min(1).max(500),
      }).strict(),
    ]).nullable().default(null),
    visual_enabled: z.boolean().default(false),
    selector: z.string().max(1000).default(""),
    selector_type: z.enum(["css", "xpath"]).default("css"),
    ignore_selectors: z.array(z.string().min(1).max(500)).max(20).default([]),
    mask_selectors: z.array(z.string().min(1).max(500)).max(20).default([]),
    ignore_text: z.array(z.string().max(500)).max(30).default([]),
    normalize_whitespace: z.boolean().default(true),
    ignore_case: z.boolean().default(false),
    capture_mode: z
      .enum(["viewport", "full_page", "element"])
      .default("viewport"),
    capture_selector: z.string().max(1000).default(""),
    capture_selector_type: z.enum(["css", "xpath"]).default("css"),
    browser_steps: stepsSchema,
    step_budget_ms: z.number().int().min(100).max(60000).default(20000),
    paused: z.boolean().default(false),
    notify_failures: z.boolean().default(false),
    notify_attention: z.boolean().default(false),
    notification_enabled: z.boolean().default(true),
    muted_until: z.string().datetime().nullable().optional(),
    notification_cooldown_seconds: z
      .union([z.literal(0), z.literal(300), z.literal(900), z.literal(1800), z.literal(3600), z.literal(21600), z.literal(86400)])
      .default(0),
    notification_mode: z.enum(["immediate", "digest"]).default("immediate"),
    digest_window_seconds: z.number().int().min(300).max(86400).default(3600),
    visual_threshold: threshold.default("0.35"),
    pixel_threshold: z.coerce.number().min(0).max(1).default(0.1),
    interval_seconds: z.number().int().min(30).max(604800).default(300),
    enabled: z.boolean().default(true),
    channel_ids: z.array(uuid).max(20).default([]),
  })
  .strict()
  .refine((m) => m.capture_mode !== "element" || !!m.capture_selector.trim(), {
    message: "Element capture requires a selector",
  })
  .refine((m) => m.kind === "browser" || m.browser_steps.length === 0, {
    message: "Browser steps require a browser monitor",
  })
  .refine(
    (m) =>
      m.text_source === "jina" || !m.browser_steps.some((s) => s.action === "fill_private") ||
      (!m.visual_enabled && new URL(m.url).protocol === "https:"),
    { message: "Private steps require HTTPS text-only capture" },
  )
  .refine((m) => m.text_enabled || m.visual_enabled, {
    message: "Enable at least one detection method",
  })
  .refine((m) => m.text_source === "direct" || (m.kind === "browser" && m.text_enabled && !m.visual_enabled), {
    message: "Jina Reader is available only for text-only Browser monitors",
  })
  .refine((m) => m.extraction_mode === "full_text" || m.text_source === "jina", {
    message: "Special extraction modes require Jina Reader",
  })
  .refine((m) => m.extraction_mode !== "selected_text" || !!m.extraction_rule, {
    message: "Selected Text extraction requires a validated rule",
  })
  .refine(
    (m) => m.kind === "browser" || (m.text_enabled && !m.visual_enabled),
    { message: "HTML/API monitors require text-only detection" },
  );
const monitoringDefaults = z.object({
  interval_seconds: z.number().int().min(30).max(604800).optional(),
  text_enabled: z.boolean().optional(), visual_enabled: z.boolean().optional(),
  capture_mode: z.enum(["viewport", "full_page", "element"]).optional(),
  visual_threshold: threshold.optional(), pixel_threshold: z.number().min(0).max(1).optional(),
  channel_ids: z.array(uuid).max(20).optional(), notification_enabled: z.boolean().optional(),
  notification_cooldown_seconds: z.union([z.literal(0), z.literal(300), z.literal(900), z.literal(1800), z.literal(3600), z.literal(21600), z.literal(86400)]).optional(),
  notification_mode: z.enum(["immediate", "digest"]).optional(),
}).strict();
const credentials = z
  .object({
    email: z
      .email()
      .max(254)
      .transform((s) => s.toLowerCase()),
    password: z
      .string()
      .min(12)
      .max(72)
      .refine((value) => Buffer.byteLength(value, "utf8") <= 72),
  })
  .strict();
const regionPreviewInput = z
  .object({
    session_id: uuid.optional(),
    preview_request_id: uuid.optional(),
    monitor_id: uuid.optional(),
    monitor: z
      .object({
        url: z.string().url().max(2048),
        kind: z.literal("browser"),
        visual_enabled: z.literal(true),
        browser_steps: stepsSchema.optional().default([]),
      })
      .strict(),
    point: z
      .object({ x: z.number().finite(), y: z.number().finite() })
      .optional(),
    refresh: z.boolean().optional().default(false),
  })
  .strict();
const textPreviewInput = z.object({
  session_id: uuid.optional(), monitor_id: uuid.optional(), url: z.string().url().max(2048).optional(),
  line_index: z.number().int().min(0).max(200_000).optional(), selected_value: z.string().min(1).max(500).optional(),
  query: z.string().max(200).optional(), offset: z.number().int().min(0).max(200_000).optional(), limit: z.number().int().min(1).max(100).optional(),
}).strict();
const channelInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    provider: z.enum(["smtp", "telegram"]),
    config: z.unknown(),
    enabled: z.boolean().default(true),
  })
  .strict();
export function createApp(
  pool: Pool,
  cfg: Config,
  policy = new EgressPolicy(),
  options: {
    frontendDir?: string;
    allowedHosts?: string[];
    requireNotificationTest?: boolean;
    telegramValidate?: TelegramValidate;
  } = {},
) {
  const app = express();
  const log = pino({ level: cfg.LOG_LEVEL });
  const previewProgress = new Map<string, { ownerId: string; stage: PreviewStage; updatedAt: number }>();
  const updatePreviewProgress = (id: string, ownerId: string, stage: PreviewStage) => {
    if (previewProgress.size > 100) for (const [key, value] of previewProgress) if (Date.now() - value.updatedAt > 120_000) previewProgress.delete(key);
    const existing = previewProgress.get(id);
    if (existing && existing.ownerId !== ownerId) return;
    if (!existing && previewProgress.size >= 256) previewProgress.delete(previewProgress.keys().next().value!);
    previewProgress.set(id, { ownerId, stage, updatedAt: Date.now() });
  };
  app.disable("x-powered-by");
  app.use(helmet());
  if (options.allowedHosts) {
    app.use((req, _res, next) => {
      if (!options.allowedHosts!.includes(req.get("Host") ?? ""))
        return next(new HttpError(400, "Host not permitted"));
      next();
    });
  }
  app.use(express.json({ limit: "32kb" }));
  app.use(
    rateLimit({
      windowMs: 60000,
      limit: 120,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
  );
  app.use((req, res, next) => {
    res.locals.requestId = randomUUID();
    res.setHeader("X-Request-Id", res.locals.requestId);
    next();
  });
  // SameSite cookie plus a non-simple header prevents cross-origin form mutations. CORS stays disabled.
  app.use((req, _res, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      if (req.get("X-Fusion-Request") !== "1")
        return next(new HttpError(403, "Request header required"));
      const origin = req.get("Origin");
      if (origin && origin !== new URL(cfg.PUBLIC_URL).origin)
        return next(new HttpError(403, "Origin not permitted"));
    }
    next();
  });
  app.get("/api/v1/health", async (_req, res) => {
    await pool.query("SELECT 1");
    res.json({ status: "ok" });
  });
  const loginLimiter = rateLimit({
    windowMs: 900000,
    limit: 15,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });
  const hashOpaqueToken = (token: string) => createHash("sha256").update(token).digest("hex");
  const readCookie = (req: Request, name: string) => req.get("Cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
  const cookieBase = { httpOnly: true, sameSite: "strict" as const, secure: cfg.NODE_ENV === "production", path: "/" };
  const clearAuthCookies = (res: Response) => {
    res.clearCookie("fusion_session", { path: "/" });
    res.clearCookie("fusion_refresh", { path: "/" });
    res.clearCookie("fusion_security", { path: "/" });
  };
  const issueAccess = (res: Response, userId: string, sessionId: string) => {
    const access = jwt.sign({ sub: userId, jti: sessionId }, cfg.JWT_SECRET, { algorithm: "HS256", expiresIn: "15m", issuer: "changd-fusion", audience: "changd-fusion-ui" });
    res.cookie("fusion_session", access, { ...cookieBase, maxAge: 15 * 60 * 1000 });
  };
  const setSession = async (res: Response, userId: string, expectedPassword?: string) => {
    const id = randomUUID(), refresh = randomBytes(32).toString("base64url");
    await transaction(pool, async (c) => {
      const user = await c.query("SELECT password FROM users WHERE user_id=$1 AND status=1 FOR UPDATE", [userId]);
      if (!user.rowCount || (expectedPassword && user.rows[0].password !== expectedPassword)) throw new HttpError(401, "Authentication required");
      await c.query("INSERT INTO fusion_sessions(id,user_id,expires_at,refresh_token_hash,refresh_expires_at) VALUES($1,$2,now()+interval '15 minutes',$3,now()+interval '30 days')", [id, userId, hashOpaqueToken(refresh)]);
    });
    issueAccess(res, userId, id);
    res.cookie("fusion_refresh", refresh, { ...cookieBase, maxAge: 30 * 24 * 60 * 60 * 1000 });
    return id;
  };
  const refreshSession = async (req: Request, res: Response) => {
    const token = readCookie(req, "fusion_refresh");
    if (!token) throw new HttpError(401, "Authentication required");
    const replacement = randomBytes(32).toString("base64url");
    const session = await transaction(pool, async (c) => {
      const result = await c.query("SELECT s.id,s.user_id FROM fusion_sessions s JOIN users u ON u.user_id=s.user_id WHERE s.refresh_token_hash=$1 AND s.revoked_at IS NULL AND s.refresh_expires_at>now() AND u.status=1 FOR UPDATE", [hashOpaqueToken(token)]);
      if (!result.rowCount) throw new HttpError(401, "Authentication required");
      const row = result.rows[0];
      await c.query("UPDATE fusion_sessions SET expires_at=now()+interval '15 minutes',refresh_expires_at=now()+interval '30 days',refresh_token_hash=$2 WHERE id=$1", [row.id, hashOpaqueToken(replacement)]);
      return row;
    });
    issueAccess(res, session.user_id, session.id);
    res.cookie("fusion_refresh", replacement, { ...cookieBase, maxAge: 30 * 24 * 60 * 60 * 1000 });
  };
  const passwordInput = z.string().min(12).max(72).refine((value) => Buffer.byteLength(value, "utf8") <= 72);
  app.post("/api/v1/login", loginLimiter, async (req, res) => {
    const body = credentials.extend({ password: z.string().min(1).max(72) }).parse(req.body);
    const result = await pool.query("SELECT user_id,password,status FROM users WHERE lower(email)=$1", [body.email]); const user = result.rows[0];
    if (!user || user.status !== 1 || !(await compare(body.password, user.password))) throw new HttpError(401, "Invalid email or password");
    await pool.query("UPDATE users SET last_login=now() WHERE user_id=$1", [user.user_id]); await setSession(res, user.user_id, user.password); res.json({ ok: true });
  });
  app.post("/api/v1/register", loginLimiter, async (req, res) => {
    if (cfg.REGISTRATION_ENABLED !== "true") throw new HttpError(403, "Public registration is disabled");
    const body = credentials.parse(req.body); const result = await pool.query("INSERT INTO users(email,password,firstname,lastname,user_type) VALUES($1,$2,$3,$4,0) ON CONFLICT DO NOTHING RETURNING user_id", [body.email, await hash(body.password, 12), "", ""]);
    if (!result.rowCount) throw new HttpError(409, "Unable to register account"); await setSession(res, result.rows[0].user_id); res.status(201).json({ ok: true });
  });
  app.post("/api/v1/session/refresh", async (req, res) => { try { await refreshSession(req, res); res.json({ ok: true }); } catch { clearAuthCookies(res); throw new HttpError(401, "Authentication required"); } });
  app.use("/api/v1", async (req, res, next) => {
    const token = req.get("Authorization")?.match(/^Bearer (.+)$/)?.[1] ?? readCookie(req, "fusion_session");
    try {
      if (!token) throw Error(); const decoded = jwt.verify(token, cfg.JWT_SECRET, { algorithms: ["HS256"], issuer: "changd-fusion", audience: "changd-fusion-ui" });
      if (typeof decoded === "string" || typeof decoded.sub !== "string" || !uuid.safeParse(decoded.jti).success) throw Error();
      const result = await pool.query("SELECT u.user_id,u.firstname,u.lastname,u.email,u.user_type FROM users u JOIN fusion_sessions s ON s.user_id=u.user_id WHERE u.user_id=$1 AND u.status=1 AND s.id=$2 AND s.revoked_at IS NULL AND s.expires_at>now()", [decoded.sub, decoded.jti]);
      if (!result.rowCount) throw Error();
      // A valid, active request keeps the revocable refresh session alive for
      // another 30 days. The refresh credential itself is still rotated only
      // by /session/refresh, so this is a sliding expiry rather than a
      // perpetual bearer token.
      await pool.query("UPDATE fusion_sessions SET refresh_expires_at=now()+interval '30 days' WHERE id=$1 AND revoked_at IS NULL", [decoded.jti]);
      res.locals.user = result.rows[0]; res.locals.sessionId = decoded.jti; res.locals.publicAccess = false; return next();
    } catch {
      try {
        const result = await pool.query("SELECT u.user_id,u.firstname,u.lastname,u.email,u.user_type FROM fusion_access_settings a JOIN users u ON u.user_id=a.owner_user_id WHERE a.singleton=true AND a.public_enabled=true AND a.owner_user_id IS NOT NULL AND u.status=1");
        if (!result.rowCount) throw Error(); res.locals.user = result.rows[0]; res.locals.sessionId = null; res.locals.publicAccess = true; return next();
      } catch { return next(new HttpError(401, "Authentication required")); }
    }
  });
  // Public access is a workspace capability, not an account session.  Only
  // account-security operations are intentionally excluded from it.
  const requireAccountSession = (_req: Request, res: Response, next: NextFunction) => {
    if (res.locals.publicAccess)
      return next(new HttpError(403, "Account security is unavailable in public access"));
    next();
  };
  const requireSecurity = async (req: Request, res: Response, next: NextFunction) => {
    if (res.locals.publicAccess)
      return next(new HttpError(403, "Account security is unavailable in public access"));
    const token = readCookie(req, "fusion_security"); if (!token) return next(new HttpError(403, "Account security verification required"));
    const grant = await pool.query("SELECT id FROM fusion_security_grants WHERE browser_token_hash=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now() AND (session_id IS NULL OR session_id=$3)", [hashOpaqueToken(token), res.locals.user.user_id, res.locals.sessionId]);
    if (!grant.rowCount) return next(new HttpError(403, "Account security verification required")); next();
  };
  app.post("/api/v1/security/verify", loginLimiter, async (req, res) => {
    const body = z.object({ email: z.email().max(254).transform((value) => value.toLowerCase()), password: z.string().min(1).max(72) }).strict().parse(req.body);
    let userId = res.locals.user.user_id, sessionId = res.locals.sessionId;
    if (res.locals.publicAccess) {
      const owner = await pool.query("SELECT u.user_id,u.email,u.password FROM fusion_access_settings a JOIN users u ON u.user_id=a.owner_user_id WHERE a.singleton=true AND a.public_enabled=true AND a.owner_user_id IS NOT NULL AND u.status=1");
      if (!owner.rowCount || body.email !== String(owner.rows[0].email).toLowerCase()) throw new HttpError(401, "Invalid email or password");
      userId = owner.rows[0].user_id;
      const account = owner.rows[0];
      if (!(await compare(body.password, account.password))) throw new HttpError(401, "Invalid email or password");
      // Public workspace access is not itself an account session. A successful
      // owner step-up creates the same revocable rotating session as login,
      // then binds the short-lived security grant to that session.
      sessionId = await setSession(res, userId, account.password);
    } else {
      if (body.email !== String(res.locals.user.email).toLowerCase()) throw new HttpError(401, "Invalid email or password");
      const account = await pool.query("SELECT password FROM users WHERE user_id=$1 AND status=1", [userId]);
      if (!account.rowCount || !(await compare(body.password, account.rows[0].password))) throw new HttpError(401, "Invalid email or password");
    }
    const token = randomBytes(32).toString("base64url");
    await pool.query("INSERT INTO fusion_security_grants(id,user_id,session_id,browser_token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '10 minutes')", [randomUUID(), userId, sessionId, hashOpaqueToken(token)]);
    res.cookie("fusion_security", token, { ...cookieBase, maxAge: 10 * 60 * 1000 }); res.json({ ok: true });
  });
  app.post("/api/v1/security/leave", requireAccountSession, async (req, res) => { const token = readCookie(req, "fusion_security"); if (token) await pool.query("UPDATE fusion_security_grants SET revoked_at=now() WHERE browser_token_hash=$1 AND revoked_at IS NULL", [hashOpaqueToken(token)]); res.clearCookie("fusion_security", { path: "/" }); res.json({ ok: true }); });
  app.get("/api/v1/account/public-access", requireSecurity, async (_req, res) => { const row = await pool.query("SELECT public_enabled,owner_user_id FROM fusion_access_settings WHERE singleton=true"); res.json(row.rows[0] ?? { public_enabled: false, owner_user_id: null }); });
  app.put("/api/v1/account/public-access", requireSecurity, async (req, res) => {
    const enabled = z.object({ enabled: z.boolean(), confirm: z.literal(true) }).strict().parse(req.body).enabled; const userId = res.locals.user.user_id;
    await transaction(pool, async (c) => { const state = await c.query("SELECT owner_user_id FROM fusion_access_settings WHERE singleton=true FOR UPDATE"); const currentOwner = state.rows[0]?.owner_user_id; if (currentOwner && currentOwner !== userId) throw new HttpError(403, "Public workspace is owned by another account"); await c.query("UPDATE fusion_access_settings SET public_enabled=$1,owner_user_id=CASE WHEN $1 THEN COALESCE(owner_user_id,$2) ELSE owner_user_id END,updated_at=now() WHERE singleton=true", [enabled, userId]); });
    res.json({ enabled });
  });
  app.post("/api/v1/logout", async (_req, res) => { if (!res.locals.publicAccess && res.locals.sessionId) await pool.query("UPDATE fusion_sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2", [res.locals.sessionId, res.locals.user.user_id]); clearAuthCookies(res); res.json({ ok: true, public_access: !!res.locals.publicAccess }); });
  app.post("/api/v1/logout-all", requireSecurity, async (_req, res) => { await transaction(pool, async (c) => { await c.query("UPDATE fusion_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [res.locals.user.user_id]); await c.query("UPDATE fusion_security_grants SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [res.locals.user.user_id]); }); clearAuthCookies(res); res.json({ ok: true }); });
  app.get("/api/v1/users/me", (_req, res) => res.locals.publicAccess ? res.json({ user_id: null, firstname: "Public", lastname: "Access", email: null, user_type: 0, public_access: true }) : res.json({ ...res.locals.user, public_access: false }));
  app.get("/api/v1/users", requireSecurity, async (_req, res) => {
    if (res.locals.publicAccess || res.locals.user.user_type !== 2) throw new HttpError(403, "Administrator required");
    res.json((await pool.query("SELECT user_id,email,firstname,lastname,status FROM users ORDER BY date_created")).rows);
  });
  app.post("/api/v1/users/changepassword", requireSecurity, async (req, res) => {
    const body = z.object({ password: passwordInput }).strict().parse(req.body);
    const id = res.locals.user.user_id;
    await transaction(pool, async (c) => {
      await c.query("UPDATE users SET password=$2 WHERE user_id=$1", [id, await hash(body.password, 12)]);
      await c.query("UPDATE fusion_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [id]);
      await c.query("UPDATE fusion_security_grants SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [id]);
    });
    clearAuthCookies(res); res.json({ ok: true });
  });
  const owner = async (id: string, userId: string) => {
    uuid.parse(id);
    const r = await pool.query(
      "SELECT * FROM fusion_monitors WHERE id=$1 AND user_id=$2",
      [id, userId],
    );
    if (!r.rowCount) throw new HttpError(404, "Monitor not found");
    return r.rows[0];
  };
  const channelOwner = async (id: string, userId: string) => {
    uuid.parse(id);
    const r = await pool.query(
      "SELECT * FROM fusion_channels WHERE id=$1 AND user_id=$2",
      [id, userId],
    );
    if (!r.rowCount) throw new HttpError(404, "Channel not found");
    return r.rows[0];
  };
  const replaceChannels = async (
    c: any,
    id: string,
    userId: string,
    ids: string[],
  ) => {
    const owned = await c.query(
      "SELECT id FROM fusion_channels WHERE id=ANY($1::uuid[]) AND user_id=$2",
      [ids, userId],
    );
    if (owned.rowCount !== new Set(ids).size)
      throw new HttpError(404, "Channel not found");
    await c.query("DELETE FROM fusion_monitor_channels WHERE monitor_id=$1", [
      id,
    ]);
    for (const channelId of new Set(ids))
      await c.query(
        "INSERT INTO fusion_monitor_channels(monitor_id,channel_id) VALUES($1,$2)",
        [id, channelId],
      );
  };
  app.get("/api/v1/preferences/monitoring", async (_req, res) => {
    const result = await pool.query(
      "SELECT monitoring_defaults FROM fusion_user_preferences WHERE user_id=$1",
      [res.locals.user.user_id],
    );
    res.json(result.rows[0]?.monitoring_defaults ?? {});
  });
  app.put("/api/v1/preferences/monitoring", async (req, res) => {
    const defaults = monitoringDefaults.parse(req.body);
    await transaction(pool, async (c) => {
      if (defaults.channel_ids) {
        const channels = await c.query(
          "SELECT id FROM fusion_channels WHERE id=ANY($1::uuid[]) AND user_id=$2",
          [defaults.channel_ids, res.locals.user.user_id],
        );
        if (channels.rowCount !== new Set(defaults.channel_ids).size)
          throw new HttpError(404, "Channel not found");
      }
      await c.query(
        "INSERT INTO fusion_user_preferences(user_id,monitoring_defaults) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET monitoring_defaults=EXCLUDED.monitoring_defaults,updated_at=now()",
        [res.locals.user.user_id, JSON.stringify(defaults)],
      );
    });
    res.json(defaults);
  });
  app.post("/api/v1/monitors/notification-channels/bulk", async (req, res) => {
    const body = z.object({ monitor_ids: z.array(uuid).min(1).max(100), channel_id: uuid, action: z.enum(["add", "remove"]), confirm: z.literal(true) }).strict().parse(req.body);
    await transaction(pool, async (c) => {
      const channel = await c.query("SELECT id FROM fusion_channels WHERE id=$1 AND user_id=$2", [body.channel_id, res.locals.user.user_id]);
      if (!channel.rowCount) throw new HttpError(404, "Channel not found");
      const monitorIds = [...new Set(body.monitor_ids)];
      const monitors = await c.query("SELECT id FROM fusion_monitors WHERE id=ANY($1::uuid[]) AND user_id=$2 FOR UPDATE", [monitorIds, res.locals.user.user_id]);
      if (monitors.rowCount !== monitorIds.length) throw new HttpError(404, "Monitor not found");
      if (body.action === "add") {
        for (const monitorId of monitorIds)
          await c.query("INSERT INTO fusion_monitor_channels(monitor_id,channel_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [monitorId, body.channel_id]);
      } else {
        await c.query("DELETE FROM fusion_monitor_channels WHERE monitor_id=ANY($1::uuid[]) AND channel_id=$2", [monitorIds, body.channel_id]);
      }
    });
    res.status(204).end();
  });
  const lockedMutation = async (
    id: string,
    userId: string,
    fn: (c: any) => Promise<unknown>,
  ) =>
    transaction(pool, async (c) => {
      // Same lock key as capture; configuration, reset and deletion cannot race a running capture.
      const lock = await c.query(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) locked",
        [id],
      );
      if (!lock.rows[0].locked)
        throw new HttpError(409, "Monitor is currently running");
      const r = await c.query(
        "SELECT id FROM fusion_monitors WHERE id=$1 AND user_id=$2 FOR UPDATE",
        [id, userId],
      );
      if (!r.rowCount) throw new HttpError(404, "Monitor not found");
      return fn(c);
    });
  app.get("/api/v1/jobs", async (_req, res) =>
    res.json(
      (
        await pool.query(
          "SELECT * FROM fusion_monitors WHERE user_id=$1 ORDER BY created_at DESC",
          [res.locals.user.user_id],
        )
      ).rows,
    ),
  );
  app.post("/api/v1/jobs", async (req, res) => {
    const b = monitorInput.parse(req.body);
    await policy.target(b.url);
    const { channel_ids, ...fields } = b;
    const result = await transaction(pool, async (c) => {
      const names = Object.keys(fields);
      const values = Object.values(fields).map((v) =>
        Array.isArray(v) ? JSON.stringify(v) : v,
      );
      const r = await c.query(
        `INSERT INTO fusion_monitors(user_id,${names.join(",")}) VALUES($1,${names.map((_, i) => "$" + (i + 2)).join(",")}) RETURNING *`,
        [res.locals.user.user_id, ...values],
      );
      if (!fields.enabled || fields.paused) {
        r.rows[0] = (
          await c.query(
            "UPDATE fusion_monitors SET monitor_state=$2 WHERE id=$1 RETURNING *",
            [r.rows[0].id, !fields.enabled ? "disabled" : "paused"],
          )
        ).rows[0];
      }
      await replaceChannels(c, r.rows[0].id, res.locals.user.user_id, channel_ids);
      return r.rows[0];
    });
    res.status(201).json(result);
  });
  app.get("/api/v1/jobs/:id", async (req, res) => {
    const id = String(req.params.id),
      monitor = await owner(id, res.locals.user.user_id);
    const channels = await pool.query(
      "SELECT channel_id FROM fusion_monitor_channels mc JOIN fusion_channels c ON c.id=mc.channel_id WHERE monitor_id=$1 AND c.user_id=$2",
      [id, res.locals.user.user_id],
    );
    res.json({
      ...monitor,
      channel_ids: channels.rows.map((r) => r.channel_id),
    });
  });
  const runRegionPreview = async (req: Request, res: Response, monitor: any, point?: { x: number; y: number }, sessionId?: string, useSession = false, previewRequestId?: string, refresh = false) => {
    const started = performance.now();
    const cancellation = new AbortController();
    const cancelled = () => { if (!res.writableEnded) cancellation.abort(); };
    req.once("aborted", cancelled);
    res.once("close", cancelled);
    try {
      const preview = await previewRegion(
        monitor,
        cfg,
        point,
        policy,
        {
          ownerId: res.locals.user.user_id,
          id: useSession ? sessionId : undefined,
          retain: useSession,
          refresh,
          signal: cancellation.signal,
          progress: previewRequestId ? (stage) => updatePreviewProgress(previewRequestId, res.locals.user.user_id, stage) : undefined,
          acquireCapacity: () => acquireChromiumLease(pool, { workload: "preview", slots: cfg.CHROMIUM_CONCURRENCY, signal: cancellation.signal }),
        },
      );
      if (previewRequestId) updatePreviewProgress(previewRequestId, res.locals.user.user_id, "ready");
      res.json(preview);
    } catch (error) {
      const failure = error as RegionPreviewFailure;
      const duration = Math.max(0, Math.round(performance.now() - started));
      // Deliberately structured and minimal: URL, query text, page content, selectors and raw errors stay out of logs.
      log.warn({ code: "region_preview_failed", stage: failure.stage, failure_code: failure.failure_code, duration_ms: duration, request_id: res.locals.requestId }, "Region preview failed");
      res.status(failure.status ?? 422).json({
        error: failure.message ?? "Website preview failed. Retry, or use viewport capture instead.",
        request_id: res.locals.requestId,
        preview_stage: failure.stage ?? "unknown",
        failure_code: failure.failure_code ?? "unknown",
        duration_ms: duration,
      });
    } finally { req.off("aborted", cancelled); res.off("close", cancelled); }
  };
  app.post("/api/v1/region-preview", async (req, res) => {
    const body = regionPreviewInput.parse(req.body);
    if (body.monitor_id) await owner(body.monitor_id, res.locals.user.user_id);
    await runRegionPreview(req, res, { ...body.monitor, id: body.monitor_id ?? "preview", browser_steps: body.monitor.browser_steps }, body.point, body.session_id, true, body.preview_request_id, body.refresh);
  });
  app.delete("/api/v1/region-preview/:sessionId", async (req, res) => {
    const sessionId = uuid.parse(req.params.sessionId);
    await releaseRegionPreviewSession(res.locals.user.user_id, sessionId);
    res.status(204).end();
  });
  app.get("/api/v1/region-preview/status/:id", (req, res) => {
    const id = uuid.parse(req.params.id);
    const progress = previewProgress.get(id);
    if (!progress || progress.ownerId !== res.locals.user.user_id || Date.now() - progress.updatedAt > 120_000) throw new HttpError(404, "Preview progress is unavailable.");
    res.json({ stage: progress.stage });
  });
  app.post("/api/v1/text-preview", async (req, res) => {
    const body = textPreviewInput.parse(req.body);
    if (body.monitor_id) await owner(body.monitor_id, res.locals.user.user_id);
    res.json(await previewJinaText({ ownerId: res.locals.user.user_id, url: body.url, sessionId: body.session_id, lineIndex: body.line_index, selectedValue: body.selected_value, query: body.query, offset: body.offset, limit: body.limit }, cfg, policy));
  });
  // Retained for already released clients. New and edited forms use the draft-aware endpoint above.
  app.post("/api/v1/jobs/:id/region-preview", async (req, res) => {
    const monitor = await owner(String(req.params.id), res.locals.user.user_id);
    const point = z.object({ x: z.number().finite(), y: z.number().finite() }).optional().parse(Object.keys(req.body ?? {}).length ? req.body : undefined);
    await runRegionPreview(req, res, monitor, point);
  });
  app.put("/api/v1/jobs/:id", async (req, res) => {
    const id = String(req.params.id);
    await owner(id, res.locals.user.user_id);
    const b = monitorInput.parse(req.body);
    await policy.target(b.url);
    const { channel_ids, ...fields } = b;
    const result = await lockedMutation(
      id,
      res.locals.user.user_id,
      async (c) => {
        const previous = (
          await c.query("SELECT * FROM fusion_monitors WHERE id=$1", [id])
        ).rows[0];
        const harmless = new Set([
          "name",
          "interval_seconds",
          "enabled",
          "paused",
          "notify_failures",
          "notify_attention",
          "notification_enabled",
          "muted_until",
          "notification_cooldown_seconds",
          "notification_mode",
          "digest_window_seconds",
          "visual_threshold",
          "pixel_threshold",
          "step_budget_ms",
          "text_direction",
        ]);
        const configurationChanged = Object.entries(fields).some(
          ([k, v]) =>
            !harmless.has(k) &&
            JSON.stringify(previous[k]) !== JSON.stringify(v),
        );
        if (new URL(previous.url).origin !== new URL(fields.url).origin)
          await c.query(
            "DELETE FROM fusion_monitor_vault WHERE monitor_id=$1",
            [id],
          );
        if (configurationChanged)
          await c.query(
            "INSERT INTO fusion_events(monitor_id,status,configuration_changed) VALUES($1,'reset',true)",
            [id],
          );
        const names = Object.keys(fields);
        const values = Object.values(fields).map((v) =>
          Array.isArray(v) ? JSON.stringify(v) : v,
        );
        const r = await c.query(
          `UPDATE fusion_monitors SET ${names.map((n, i) => n + "=$" + (i + 2)).join(",")},baseline_id=CASE WHEN $${names.length + 2} THEN NULL ELSE baseline_id END,monitor_state=CASE WHEN NOT $${names.indexOf("enabled") + 2} THEN 'disabled' WHEN $${names.indexOf("paused") + 2} THEN 'paused' WHEN $${names.length + 2} OR baseline_id IS NULL THEN 'waiting_baseline' WHEN monitor_state IN ('paused','disabled') THEN 'healthy' ELSE monitor_state END,next_run=now() WHERE id=$1 RETURNING *`,
          [id, ...values, configurationChanged],
        );
        await replaceChannels(c, id, res.locals.user.user_id, channel_ids);
        return r.rows[0];
      },
    );
    res.json(result);
  });
  app.post("/api/v1/jobs/:id/run", async (req, res) => {
    const id = String(req.params.id);
    const monitor = await owner(id, res.locals.user.user_id);
    if (!monitor.enabled || monitor.paused)
      throw new HttpError(409, "Enable the monitor before running it");
    await pool.query(
      "UPDATE fusion_monitors SET next_run=now() WHERE id=$1 AND user_id=$2",
      [id, res.locals.user.user_id],
    );
    res.status(202).json({ queued: true });
  });
  app.post("/api/v1/jobs/:id/reset", async (req, res) => {
    const id = String(req.params.id);
    await owner(id, res.locals.user.user_id);
    await lockedMutation(id, res.locals.user.user_id, async (c) => {
      await c.query(
        "UPDATE fusion_monitors SET baseline_id=null,monitor_state='waiting_baseline',next_run=now() WHERE id=$1",
        [id],
      );
      await c.query(
        "INSERT INTO fusion_events(monitor_id,status) VALUES($1,'reset')",
        [id],
      );
    });
    res.json({ ok: true });
  });
  app.delete("/api/v1/jobs/:id", async (req, res) => {
    const id = String(req.params.id);
    await owner(id, res.locals.user.user_id);
    await lockedMutation(id, res.locals.user.user_id, async (c) => {
      // Delete events before captures because historical references are deliberately restrictive.
      await c.query("DELETE FROM fusion_events WHERE monitor_id=$1", [id]);
      await c.query("DELETE FROM fusion_monitors WHERE id=$1", [id]);
    });
    res.json({ ok: true });
  });
  app.get("/api/v1/jobs/:id/private-values", async (req, res) => {
    const id = String(req.params.id);
    await owner(id, res.locals.user.user_id);
    const r = await pool.query(
      "SELECT value_names,expires_at,updated_at FROM fusion_monitor_vault WHERE monitor_id=$1 AND user_id=$2",
      [id, res.locals.user.user_id],
    );
    res.setHeader("Cache-Control", "private, no-store");
    res.json(r.rows[0] ?? { value_names: [] });
  });
  app.put("/api/v1/jobs/:id/private-values", async (req, res) => {
    const id = String(req.params.id),
      m = await owner(id, res.locals.user.user_id),
      b = vaultSchema.parse(req.body);
    if (
      m.kind !== "browser" ||
      m.visual_enabled ||
      new URL(m.url).protocol !== "https:"
    )
      throw new HttpError(
        422,
        "Private values require an HTTPS text-only browser monitor",
      );
    const origin = new URL(m.url).origin;
    await policy.target(m.url);
    await lockedMutation(id, res.locals.user.user_id, async (c) => {
      const latest = (
        await c.query(
          "SELECT url,visual_enabled,kind FROM fusion_monitors WHERE id=$1",
          [id],
        )
      ).rows[0];
      if (
        latest.url !== m.url ||
        latest.visual_enabled ||
        latest.kind !== "browser"
      )
        throw new HttpError(409, "Monitor configuration changed. Retry.");
      await c.query(
        "INSERT INTO fusion_monitor_vault(monitor_id,user_id,origin,encrypted,value_names,expires_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(monitor_id) DO UPDATE SET origin=EXCLUDED.origin,encrypted=EXCLUDED.encrypted,value_names=EXCLUDED.value_names,expires_at=EXCLUDED.expires_at,updated_at=now()",
        [
          id,
          m.user_id,
          origin,
          sealValues(b.values, cfg.CHANNEL_KEY, id, m.user_id, origin),
          JSON.stringify(Object.keys(b.values)),
          b.expires_at,
        ],
      );
      await c.query(
        "UPDATE fusion_monitors SET baseline_id=null,monitor_state='waiting_baseline',next_run=now() WHERE id=$1",
        [id],
      );
      await c.query(
        "INSERT INTO fusion_events(monitor_id,status,configuration_changed) VALUES($1,'reset',true)",
        [id],
      );
    });
    res.json({ ok: true });
  });
  app.delete("/api/v1/jobs/:id/private-values", async (req, res) => {
    const id = String(req.params.id);
    await owner(id, res.locals.user.user_id);
    await lockedMutation(id, res.locals.user.user_id, async (c) => {
      await c.query(
        "DELETE FROM fusion_monitor_vault WHERE monitor_id=$1 AND user_id=$2",
        [id, res.locals.user.user_id],
      );
      await c.query("UPDATE fusion_monitors SET next_run=now() WHERE id=$1", [
        id,
      ]);
    });
    res.json({ ok: true });
  });
  app.get("/api/v1/jobs/:id/history", async (req, res) => {
    const id = String(req.params.id);
    await owner(id, res.locals.user.user_id);
    const status = z
      .enum([
        "baseline",
        "unchanged",
        "changed",
        "failed",
        "reset",
        "legacy",
        "test",
        "extraction_transition",
      ])
      .optional()
      .parse(req.query.status);
    const paginated = req.query.page !== undefined;
    const page = z.coerce
      .number()
      .int()
      .min(1)
      .max(100000)
      .default(1)
      .parse(req.query.page);
    const size = z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .parse(req.query.page_size);
    const r = await pool.query(
      `SELECT e.*,b.screenshot before_image,a.screenshot after_image,
   coalesce((SELECT jsonb_agg(jsonb_build_object('channel_id',o.channel_id,'status',o.status,'attempts',o.attempts,'error',o.last_error)) FROM fusion_outbox o WHERE o.event_id=e.id),'[]'::jsonb) deliveries
   FROM fusion_events e LEFT JOIN fusion_captures b ON b.id=e.before_id LEFT JOIN fusion_captures a ON a.id=e.after_id
   WHERE e.monitor_id=$1 AND ($2::text IS NULL OR e.status=$2) ORDER BY e.created_at DESC,e.id DESC LIMIT $3 OFFSET $4`,
      [
        id,
        status ?? null,
        paginated ? size : 100,
        paginated ? (page - 1) * size : 0,
      ],
    );
    if (!paginated) return res.json(r.rows);
    const count = await pool.query(
      "SELECT count(*) FROM fusion_events WHERE monitor_id=$1 AND ($2::text IS NULL OR status=$2)",
      [id, status ?? null],
    );
    res.json({
      items: r.rows,
      total: Number(count.rows[0].count),
      page,
      page_size: size,
    });
  });
  const timelineStatus = z.enum([
    "baseline",
    "unchanged",
    "changed",
    "failed",
    "reset",
    "legacy",
    "test",
    "digest",
    "extraction_transition",
  ]);
  const timelineDate = z
    .string()
    .datetime({ offset: true })
    .transform((value) => new Date(value));
  const timelineFilterQuery = z
    .object({
      monitor_id: uuid.optional(),
      status: timelineStatus.optional(),
      from: timelineDate.optional(),
      to: timelineDate.optional(),
    })
    .strict()
    .refine((value) => !value.from || !value.to || value.from <= value.to, {
      message: "Start date must precede end date",
    });
  const timelineQuery = timelineFilterQuery
    .extend({
      page: z.coerce.number().int().min(1).max(100000).default(1),
      page_size: z.coerce.number().int().min(1).max(100).default(25),
    })
    .refine((value) => !value.from || !value.to || value.from <= value.to, {
      message: "Start date must precede end date",
    });
  const eventScope = (query: z.infer<typeof timelineQuery>, userId: string) => [
    userId,
    query.monitor_id ?? null,
    query.status ?? null,
    query.from ?? null,
    query.to ?? null,
  ];
  app.get("/api/v1/timeline", async (req, res) => {
    const query = timelineQuery.parse(req.query);
    const values = eventScope(query, res.locals.user.user_id);
    const where = `m.user_id=$1
      AND ($2::uuid IS NULL OR e.monitor_id=$2)
      AND ($3::text IS NULL OR e.status=$3)
      AND ($4::timestamptz IS NULL OR e.created_at >= $4)
      AND ($5::timestamptz IS NULL OR e.created_at <= $5)`;
    const [events, count] = await Promise.all([
      pool.query(
        `SELECT e.id,e.monitor_id,m.name AS monitor_name,e.status,e.text_changed,e.visual_changed,
          e.visual_percent,e.dimension_changed,e.attention_state,e.warning_code,e.failure_stage,
          e.failure_code,e.error,e.created_at,e.execution_ms,e.notification_state,
          EXISTS(SELECT 1 FROM jsonb_array_elements(e.text_diff) p WHERE COALESCE((p->>'added')::boolean,false)) AS text_added,
          EXISTS(SELECT 1 FROM jsonb_array_elements(e.text_diff) p WHERE COALESCE((p->>'removed')::boolean,false)) AS text_removed
         FROM fusion_events e JOIN fusion_monitors m ON m.id=e.monitor_id
         WHERE ${where} ORDER BY e.created_at DESC,e.id DESC LIMIT $6 OFFSET $7`,
        [...values, query.page_size, (query.page - 1) * query.page_size],
      ),
      pool.query(`SELECT count(*) FROM fusion_events e JOIN fusion_monitors m ON m.id=e.monitor_id WHERE ${where}`, values),
    ]);
    res.json({
      items: events.rows,
      total: Number(count.rows[0].count),
      page: query.page,
      page_size: query.page_size,
    });
  });
  app.get("/api/v1/analytics", async (req, res) => {
    const query = timelineFilterQuery.parse(req.query);
    const values = eventScope({ ...query, page: 1, page_size: 25 }, res.locals.user.user_id);
    const where = `m.user_id=$1
      AND ($2::uuid IS NULL OR e.monitor_id=$2)
      AND ($3::text IS NULL OR e.status=$3)
      AND ($4::timestamptz IS NULL OR e.created_at >= $4)
      AND ($5::timestamptz IS NULL OR e.created_at <= $5)`;
    const [summary, distribution, trend] = await Promise.all([
      pool.query(
        `SELECT count(*) total,
          count(*) FILTER (WHERE e.status='changed') changed,
          count(*) FILTER (WHERE e.status='failed') failed,
          count(*) FILTER (WHERE e.status IN ('baseline','unchanged','changed','extraction_transition')) successful
         FROM fusion_events e JOIN fusion_monitors m ON m.id=e.monitor_id WHERE ${where}`,
        values,
      ),
      pool.query(
        `SELECT e.status,count(*)::int AS count FROM fusion_events e JOIN fusion_monitors m ON m.id=e.monitor_id
         WHERE ${where} GROUP BY e.status ORDER BY count DESC,e.status ASC`,
        values,
      ),
      pool.query(
        `SELECT to_char(date_trunc('day',e.created_at AT TIME ZONE 'UTC'),'YYYY-MM-DD') AS day,
          count(*)::int AS total,
          count(*) FILTER (WHERE e.status='changed')::int AS changed,
          count(*) FILTER (WHERE e.status='failed')::int AS failed,
          count(*) FILTER (WHERE e.status IN ('baseline','unchanged','changed','extraction_transition'))::int AS successful
         FROM fusion_events e JOIN fusion_monitors m ON m.id=e.monitor_id
         WHERE ${where} GROUP BY date_trunc('day',e.created_at AT TIME ZONE 'UTC') ORDER BY day ASC`,
        values,
      ),
    ]);
    res.json({ summary: summary.rows[0], distribution: distribution.rows, trend: trend.rows });
  });
  app.get("/api/v1/screenshots/:name", async (req, res) => {
    const name = z
      .string()
      .regex(/^[a-f\d-]{36}\.png$/)
      .parse(req.params.name);
    const refs = await pool.query(
      `SELECT 1 FROM fusion_monitors m WHERE m.user_id=$1 AND (EXISTS(SELECT 1 FROM fusion_captures c WHERE c.monitor_id=m.id AND c.screenshot=$2) OR EXISTS(SELECT 1 FROM fusion_events e WHERE e.monitor_id=m.id AND e.diff_screenshot=$2)) LIMIT 1`,
      [res.locals.user.user_id, name],
    );
    if (!refs.rowCount) throw new HttpError(404, "Screenshot not found");
    const file = await new Storage(cfg.DATA_DIR).file(name);
    res.setHeader("Cache-Control", "private, no-store");
    // Only the owner-authorized, canonical artifact is served. An ignored/hidden DATA_DIR
    // is a valid storage root; credentials and arbitrary dotfiles remain inaccessible.
    res.sendFile(path.basename(file), { root: path.dirname(file) });
  });
  const publicChannel = (row: any) => {
    const value = decrypt(row.config.encrypted, cfg.CHANNEL_KEY);
    const { password, token, ...safe } = value;
    return {
      id: row.id,
      name: row.name,
      provider: row.provider,
      enabled: row.enabled,
      config: safe,
      test_required: Boolean(
        row.config.preview_test_required && !row.config.preview_verified,
      ),
    };
  };
  app.get("/api/v1/notifications", async (_req, res) =>
    res.json(
      (
        await pool.query(
          "SELECT * FROM fusion_channels WHERE user_id=$1 ORDER BY created_at DESC",
          [res.locals.user.user_id],
        )
      ).rows.map(publicChannel),
    ),
  );
  app.get("/api/v1/notifications/preview/:kind", async (req, res) => {
    const kind = z.enum(["text","visual","combined","dimensions","failure","authentication","challenge","test","digest"]).parse(req.params.kind);
    const attention = kind === "failure" ? "persistent_failure" : kind === "authentication" ? "authentication_required" : kind === "challenge" ? "challenge_detected" : undefined;
    res.json({ text: telegramSummary({ id: "preview", name: "Example Product Tracker", monitorId: "preview", textChanged: kind === "text" || kind === "combined", visualChanged: kind === "visual" || kind === "combined" || kind === "dimensions", dimensionChanged: kind === "dimensions", beforeDimensions: { width: 1280, height: 900 }, afterDimensions: { width: 1280, height: 960 }, percent: "0.35", textSummary: "Added: Price information updated", link: new URL("/jobs/preview", cfg.PUBLIC_URL).href, attentionState: attention, checkedAt: new Date("2026-10-11T00:15:00Z"), eventType: kind === "test" ? "test" : kind === "digest" ? "digest" : "changed", digestCount: 5, images: [] }, "UTC") });
  });
  app.post("/api/v1/notifications", async (req, res) => {
    const b = channelInput.parse(req.body),
      value = (b.provider === "smtp" ? smtpSchema : telegramSchema).parse(
        b.config,
      );
    const r = await pool.query(
      "INSERT INTO fusion_channels(user_id,name,provider,config,enabled) VALUES($1,$2,$3,$4,$5) RETURNING *",
      [
        res.locals.user.user_id,
        b.name,
        b.provider,
        JSON.stringify({
          encrypted: encrypt(value, cfg.CHANNEL_KEY),
          ...(b.provider === "telegram" && options.requireNotificationTest
            ? { preview_test_required: true, preview_verified: false }
            : {}),
        }),
        b.enabled,
      ],
    );
    res.status(201).json(publicChannel(r.rows[0]));
  });
  app.put("/api/v1/notifications/:id", async (req, res) => {
    const id = String(req.params.id);
    const current = await channelOwner(id, res.locals.user.user_id),
      b = channelInput.parse(req.body);
    const old = decrypt(current.config.encrypted, cfg.CHANNEL_KEY),
      incoming = b.config as any;
    const value = (b.provider === "smtp" ? smtpSchema : telegramSchema).parse({
      ...incoming,
      ...(b.provider === current.provider
        ? Object.fromEntries(
            (b.provider === "smtp" ? ["password"] : ["token"])
              .filter((k) => !incoming?.[k])
              .map((k) => [k, old[k]]),
          )
        : {}),
    });
    const r = await pool.query(
      "UPDATE fusion_channels SET name=$3,provider=$4,config=$5,enabled=$6 WHERE id=$1 AND user_id=$2 RETURNING *",
      [
        id,
        res.locals.user.user_id,
        b.name,
        b.provider,
        JSON.stringify({
          encrypted: encrypt(value, cfg.CHANNEL_KEY),
          ...(b.provider === "telegram" &&
          (options.requireNotificationTest ||
            current.config.preview_test_required)
            ? {
                preview_test_required: true,
                preview_verified: Boolean(
                  current.config.preview_verified &&
                    old.token === (value as any).token &&
                    old.chat_id === (value as any).chat_id,
                ),
              }
            : {}),
        }),
        b.enabled,
      ],
    );
    res.json(publicChannel(r.rows[0]));
  });
  app.delete("/api/v1/notifications/:id", async (req, res) => {
    const id = String(req.params.id);
    await channelOwner(id, res.locals.user.user_id);
    await pool.query("DELETE FROM fusion_channels WHERE id=$1 AND user_id=$2", [
      id,
      res.locals.user.user_id,
    ]);
    res.json({ ok: true });
  });
  app.get("/api/v1/deliveries", async (req, res) => {
    const page = z.coerce
      .number()
      .int()
      .min(1)
      .max(100000)
      .default(1)
      .parse(req.query.page);
    const size = z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .parse(req.query.page_size);
    const status = z
      .enum(["pending", "retrying", "sending", "sent", "failed"])
      .optional()
      .parse(req.query.status);
    const where =
      "ch.user_id=$1 AND m.user_id=$1 AND ($2::text IS NULL OR CASE WHEN o.status='pending' AND o.attempts>0 THEN 'retrying' ELSE o.status END=$2)";
    const from =
      "FROM fusion_outbox o JOIN fusion_channels ch ON ch.id=o.channel_id JOIN fusion_events e ON e.id=o.event_id JOIN fusion_monitors m ON m.id=e.monitor_id";
    const r = await pool.query(
      `SELECT o.id,o.event_id,o.channel_id,ch.name channel_name,m.id monitor_id,m.name monitor_name,o.attempts,o.next_attempt,o.delivered_at,o.last_error,CASE WHEN o.status='pending' AND o.attempts>0 THEN 'retrying' ELSE o.status END status ${from} WHERE ${where} ORDER BY o.next_attempt DESC,o.id DESC LIMIT $3 OFFSET $4`,
      [res.locals.user.user_id, status ?? null, size, (page - 1) * size],
    );
    const count = await pool.query(`SELECT count(*) ${from} WHERE ${where}`, [
      res.locals.user.user_id,
      status ?? null,
    ]);
    res.json({
      items: r.rows,
      total: Number(count.rows[0].count),
      page,
      page_size: size,
    });
  });
  app.post("/api/v1/deliveries/:id/retry", async (req, res) => {
    const id = uuid.parse(req.params.id);
    if (res.locals.user.user_type !== 2)
      throw new HttpError(403, "Administrator required");
    await transaction(pool, async (c) => {
      const lock = await c.query(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1,1)) locked",
        [id],
      );
      if (!lock.rows[0].locked)
        throw new HttpError(409, "Delivery is currently running");
      const r = await c.query(
        "UPDATE fusion_outbox o SET status='pending',attempts=0,next_attempt=now(),last_error=null FROM fusion_channels ch,fusion_events e,fusion_monitors m WHERE o.id=$1 AND o.status='failed' AND ch.id=o.channel_id AND ch.enabled AND ch.user_id=$2 AND e.id=o.event_id AND m.id=e.monitor_id AND m.user_id=$2 RETURNING o.id",
        [id, res.locals.user.user_id],
      );
      if (!r.rowCount) throw new HttpError(404, "Failed delivery not found");
    });
    res.status(202).json({ queued: true });
  });
  app.post("/api/v1/notifications/:id/test", async (req, res) => {
    const channelId = String(req.params.id);
    await channelOwner(channelId, res.locals.user.user_id);
    const { monitor_id } = z
      .object({ monitor_id: uuid })
      .strict()
      .parse(req.body);
    await owner(monitor_id, res.locals.user.user_id);
    await transaction(pool, async (c) => {
      const e = await c.query(
        "INSERT INTO fusion_events(monitor_id,status,text_changed,text_diff) VALUES($1,'test',true,$2) RETURNING id",
        [
          monitor_id,
          JSON.stringify([
            { value: "Test notification", added: true, removed: false },
          ]),
        ],
      );
      await c.query(
        "INSERT INTO fusion_outbox(event_id,channel_id) VALUES($1,$2)",
        [e.rows[0].id, channelId],
      );
    });
    res.status(202).json({ queued: true });
  });
  app.post("/api/v1/notifications/:id/validate", async (req, res) => {
    const current = await channelOwner(String(req.params.id), res.locals.user.user_id);
    if (current.provider !== "telegram") throw new HttpError(400, "Telegram channel required");
    const config = telegramSchema.parse(decrypt(current.config.encrypted, cfg.CHANNEL_KEY));
    try {
      const bot = await (options.telegramValidate ?? telegramValidate)(config.token);
      res.json({ valid: true, bot });
    } catch {
      throw new HttpError(400, "Telegram bot validation failed");
    }
  });
  if (options.frontendDir) {
    app.use(
      express.static(options.frontendDir, { dotfiles: "deny", index: false }),
    );
    app.get(["/", "/jobs/:id"], (_req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.sendFile("index.html", { root: options.frontendDir! });
    });
  }
  app.use((_req, _res, next) => next(new HttpError(404, "Not found")));
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    const status =
      error instanceof HttpError
        ? error.status
        : error instanceof z.ZodError
          ? 400
          : error.type === "entity.too.large"
            ? 413
            : 500;
    log[status >= 500 ? "error" : "warn"](
      { requestId: res.locals.requestId, code: "request_failed", status },
      "Request failed",
    );
    res.status(status).json({
      error:
        status === 400
          ? "Invalid request"
          : status === 413
            ? "Request too large"
            : status >= 500
              ? "Operation failed"
              : error.message,
      request_id: res.locals.requestId,
    });
  });
  return app;
}
