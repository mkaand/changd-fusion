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
import { smtpSchema, telegramSchema } from "./notifications.js";
import { Storage } from "./storage.js";
import { randomUUID } from "node:crypto";
import pino from "pino";
import { Decimal } from "decimal.js";
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
    visual_enabled: z.boolean().default(false),
    selector: z.string().max(1000).default(""),
    selector_type: z.enum(["css", "xpath"]).default("css"),
    ignore_selectors: z.array(z.string().min(1).max(500)).max(20).default([]),
    mask_selectors: z.array(z.string().min(1).max(500)).max(20).default([]),
    ignore_text: z.array(z.string().max(500)).max(30).default([]),
    normalize_whitespace: z.boolean().default(true),
    ignore_case: z.boolean().default(false),
    visual_threshold: threshold.default("0.35"),
    pixel_threshold: z.coerce.number().min(0).max(1).default(0.1),
    interval_seconds: z.number().int().min(30).max(604800).default(300),
    enabled: z.boolean().default(true),
    channel_ids: z.array(uuid).max(20).default([]),
  })
  .strict()
  .refine((m) => m.text_enabled || m.visual_enabled, {
    message: "Enable at least one detection method",
  })
  .refine(
    (m) => m.kind === "browser" || (m.text_enabled && !m.visual_enabled),
    { message: "HTML/API monitors require text-only detection" },
  );
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
) {
  const app = express();
  const log = pino({ level: cfg.LOG_LEVEL });
  app.disable("x-powered-by");
  app.use(helmet());
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
  const setSession = (res: Response, userId: string) => {
    const token = jwt.sign({ sub: userId }, cfg.JWT_SECRET, {
      algorithm: "HS256",
      expiresIn: "2h",
      issuer: "changd-fusion",
      audience: "changd-fusion-ui",
    });
    res.cookie("fusion_session", token, {
      httpOnly: true,
      sameSite: "strict",
      secure: cfg.NODE_ENV === "production",
      path: "/",
      maxAge: 7200000,
    });
  };
  app.post("/api/v1/login", loginLimiter, async (req, res) => {
    // Existing passwords can be shorter than the new creation minimum.
    const body = credentials
      .extend({ password: z.string().min(1).max(72) })
      .parse(req.body);
    const r = await pool.query(
      "SELECT user_id,password,status FROM users WHERE lower(email)=$1",
      [body.email],
    );
    const user = r.rows[0];
    if (
      !user ||
      user.status !== 1 ||
      !(await compare(body.password, user.password))
    )
      throw new HttpError(401, "Invalid email or password");
    await pool.query("UPDATE users SET last_login=now() WHERE user_id=$1", [
      user.user_id,
    ]);
    setSession(res, user.user_id);
    res.json({ ok: true });
  });
  app.post("/api/v1/register", loginLimiter, async (req, res) => {
    if (cfg.REGISTRATION_ENABLED !== "true")
      throw new HttpError(403, "Public registration is disabled");
    const body = credentials.parse(req.body);
    const r = await pool.query(
      "INSERT INTO users(email,password,firstname,lastname,user_type) VALUES($1,$2,$3,$4,0) ON CONFLICT DO NOTHING RETURNING user_id",
      [body.email, await hash(body.password, 12), "", ""],
    );
    if (!r.rowCount) throw new HttpError(409, "Unable to register account");
    setSession(res, r.rows[0].user_id);
    res.status(201).json({ ok: true });
  });
  app.post("/api/v1/logout", (_req, res) => {
    res.clearCookie("fusion_session", { path: "/" });
    res.json({ ok: true });
  });
  app.use("/api/v1", async (req, res, next) => {
    const cookie = req
      .get("Cookie")
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("fusion_session="))
      ?.slice("fusion_session=".length);
    const token =
      req.get("Authorization")?.match(/^Bearer (.+)$/)?.[1] ?? cookie;
    try {
      if (!token) throw Error();
      const decoded = jwt.verify(token, cfg.JWT_SECRET, {
        algorithms: ["HS256"],
        issuer: "changd-fusion",
        audience: "changd-fusion-ui",
      });
      if (typeof decoded === "string" || typeof decoded.sub !== "string")
        throw Error();
      const result = await pool.query(
        "SELECT user_id,firstname,lastname,email,user_type FROM users WHERE user_id=$1 AND status=1",
        [decoded.sub],
      );
      if (!result.rowCount) throw Error();
      res.locals.user = result.rows[0];
      next();
    } catch {
      next(new HttpError(401, "Authentication required"));
    }
  });
  app.get("/api/v1/users/me", (_req, res) => res.json(res.locals.user));
  app.get("/api/v1/users", async (_req, res) => {
    if (res.locals.user.user_type !== 2)
      throw new HttpError(403, "Administrator required");
    res.json(
      (
        await pool.query(
          "SELECT user_id,email,firstname,lastname,status FROM users ORDER BY date_created",
        )
      ).rows,
    );
  });
  app.post("/api/v1/users/changepassword", async (req, res) => {
    const b = z
      .object({
        current_password: z.string().max(72),
        password: z
          .string()
          .min(12)
          .max(72)
          .refine((value) => Buffer.byteLength(value, "utf8") <= 72),
      })
      .strict()
      .parse(req.body);
    const id = res.locals.user.user_id;
    const r = await pool.query("SELECT password FROM users WHERE user_id=$1", [
      id,
    ]);
    if (!(await compare(b.current_password, r.rows[0].password)))
      throw new HttpError(401, "Invalid password");
    await pool.query("UPDATE users SET password=$2 WHERE user_id=$1", [
      id,
      await hash(b.password, 12),
    ]);
    res.json({ ok: true });
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
      await replaceChannels(
        c,
        r.rows[0].id,
        res.locals.user.user_id,
        channel_ids,
      );
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
        const names = Object.keys(fields);
        const values = Object.values(fields).map((v) =>
          Array.isArray(v) ? JSON.stringify(v) : v,
        );
        const r = await c.query(
          `UPDATE fusion_monitors SET ${names.map((n, i) => n + "=$" + (i + 2)).join(",")},baseline_id=null,next_run=now(),last_error=null,failure_count=0 WHERE id=$1 RETURNING *`,
          [id, ...values],
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
    if (!monitor.enabled)
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
        "UPDATE fusion_monitors SET baseline_id=null,next_run=now() WHERE id=$1",
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
      ])
      .optional()
      .parse(req.query.status);
    const r = await pool.query(
      `SELECT e.*,b.screenshot before_image,a.screenshot after_image,
   coalesce((SELECT jsonb_agg(jsonb_build_object('channel_id',o.channel_id,'status',o.status,'attempts',o.attempts,'error',o.last_error)) FROM fusion_outbox o WHERE o.event_id=e.id),'[]'::jsonb) deliveries
   FROM fusion_events e LEFT JOIN fusion_captures b ON b.id=e.before_id LEFT JOIN fusion_captures a ON a.id=e.after_id
   WHERE e.monitor_id=$1 AND ($2::text IS NULL OR e.status=$2) ORDER BY e.created_at DESC LIMIT 100`,
      [id, status ?? null],
    );
    res.json(r.rows);
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
    res.sendFile(file);
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
        JSON.stringify({ encrypted: encrypt(value, cfg.CHANNEL_KEY) }),
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
            ["password", "token"]
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
        JSON.stringify({ encrypted: encrypt(value, cfg.CHANNEL_KEY) }),
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
