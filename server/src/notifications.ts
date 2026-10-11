import nodemailer from "nodemailer";
import https from "node:https";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { EgressPolicy } from "./egress.js";
import { Storage } from "./storage.js";
import { pngDimensions } from "./image.js";
export const smtpSchema = z
  .object({
    host: z.string().min(1).max(253),
    port: z.union([z.literal(465), z.literal(587)]),
    username: z.string().max(256).default(""),
    password: z.string().max(512).default(""),
    from: z.email(),
    to: z.email(),
  })
  .strict();
export const telegramSchema = z
  .object({
    token: z.string().regex(/^\d+:[A-Za-z0-9_-]{20,}$/),
    chat_id: z.string().regex(/^-?\d+$/),
    timezone: z
      .string()
      .max(100)
      .default("UTC")
      .refine((value) => {
        try {
          new Intl.DateTimeFormat("en-GB", { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, "Invalid timezone"),
  })
  .strict();
export type EventMessage = {
  id: string;
  name: string;
  monitorId: string;
  textChanged: boolean;
  visualChanged: boolean;
  percent: string | null;
  dimensionChanged?: boolean;
  beforeDimensions?: { width: number; height: number } | null;
  afterDimensions?: { width: number; height: number } | null;
  textSummary: string;
  link: string;
  images: string[];
  attentionState?: string | null;
  attentionMessage?: string | null;
  checkedAt?: Date | string;
  eventType?: string;
  attempt?: number;
  imageLabels?: ("before" | "after" | "diff")[];
  digestCount?: number;
  digestStart?: string;
  digestEnd?: string;
};
export const escapeHTML = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export const formatPercent = (value: string) =>
  value.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
export function visualSummary(event: EventMessage) {
  if (event.dimensionChanged) {
    const size = (s: EventMessage["beforeDimensions"]) =>
      s ? `${s.width}×${s.height}` : "unknown";
    return `Screenshot dimensions changed: ${size(event.beforeDimensions)} → ${size(event.afterDimensions)}. Pixel percentage unavailable; new capture becomes baseline.`;
  }
  return `Visual change: ${formatPercent(event.percent ?? "0")}%`;
}
export function summary(event: EventMessage) {
  return `${event.name}\n${event.attentionState ? event.attentionState.replaceAll("_", " ") + ": " + (event.attentionMessage ?? "Requires attention") + "\n" : ""}${event.textChanged ? "Text changed: " + event.textSummary + "\n" : ""}${event.visualChanged ? visualSummary(event) + "\n" : ""}${event.link}`;
}
// Plain text only: never enable Telegram HTML/Markdown parsing for user content.
export function truncateText(value: string, limit: number) {
  let result = "";
  for (const c of value.replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,
    "",
  )) {
    if (result.length + c.length > limit - 1) return result + "…";
    result += c;
  }
  return result;
}
function removeLargeJSON(value: string) {
  let result = "";
  for (let start = 0; start < value.length; start++) {
    const opener = value[start];
    if (opener !== "{" && opener !== "[") {
      result += opener;
      continue;
    }
    const stack = [opener === "{" ? "}" : "]"];
    let quote = "", escaped = false, end = start + 1;
    for (; end < value.length && stack.length; end++) {
      const char = value[end];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = "";
      } else if (char === '"') quote = char;
      else if (char === "{") stack.push("}");
      else if (char === "[") stack.push("]");
      else if (char === stack.at(-1)) stack.pop();
    }
    const candidate = value.slice(start, end);
    if (stack.length || candidate.length <= 120) {
      result += opener;
      continue;
    }
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") {
        result += " ";
        start = end - 1;
        continue;
      }
    } catch {}
    result += opener;
  }
  return result;
}
export function safeTextSummary(parts: Array<{ value?: unknown; added?: boolean; removed?: boolean }>) {
  const sensitive = /(authorization|bearer\s+|cookie|bot\d{5,}:|token\s*[=:])/i;
  const values = parts.filter((p) => p.added || p.removed).map((p) => ({ mark: p.added ? "Added" : "Removed", value: String(p.value ?? "") }));
  const meaningful = values.map(({ mark, value }) => {
    const cleaned = removeLargeJSON(value)
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (
      !cleaned ||
      sensitive.test(cleaned) ||
      /^(?:skip to content|navigation|main content)$/i.test(cleaned) ||
      (/^[{[]/.test(cleaned) && cleaned.length > 100)
    )
      return null;
    return `${mark}: ${truncateText(cleaned.replace(/https?:\/\/[^\s?#]+(?:\?[^\s#]*)?/g, "[URL]"), 280)}`;
  }).filter(Boolean) as string[];
  return truncateText(meaningful.slice(0, 3).join(" · ") || "Content changed. View the full difference.", 900);
}
// English is the default; keep translations outside provider transport/security logic.
export const telegramEnglish = {
  attention: {
    persistent_failure: [
      "⚠️ Persistent Monitoring Failure",
      "⚠️ Status: Monitoring failed repeatedly. Check the configuration.",
    ],
    authentication_required: [
      "🔐 Sign-in Required",
      "🔐 Status: Check the session or sign-in settings.",
    ],
    challenge_detected: [
      "🧩 Possible Challenge",
      "🧩 Status: A CAPTCHA or anti-bot check may be present. No bypass was attempted.",
    ],
  } as Record<string, [string, string]>,
  captions: {
    "before.png": "Before",
    "after.png": "After",
    "diff.png": "Diff",
  } as Record<string, string>,
};

export function telegramSummary(
  event: EventMessage,
  timezone = "Europe/Istanbul",
) {
  const state = telegramEnglish.attention[event.attentionState ?? ""];
  const test = event.eventType === "test";
  const digest = event.eventType === "digest";
  const lines = [
    `🔔 Changd Fusion | ${state?.[0] ?? (digest ? "Monitoring Digest" : test ? "Test Notification" : "Change Detected!")}`,
    "",
    `🌐 Monitor: ${truncateText(event.name, 120)}`,
    state?.[1] ??
      (digest
        ? `📝 ${Math.max(1, Number(event.digestCount ?? 1))} changes detected during the selected period`
        : test
        ? "🟢 Status: Testing the notification channel"
        : "🟢 Status: Content changed"),
  ];
  if (event.textChanged && !test && !state && !digest)
    lines.push(
      `📝 Text: ${truncateText(event.textSummary || "Content changed. View the full difference.", 900)}`,
    );
  if (event.dimensionChanged && !state) {
    const size = (s: EventMessage["beforeDimensions"]) =>
      s ? `${s.width}×${s.height}` : "unknown";
    lines.push(
      `📐 Dimensions: ${size(event.beforeDimensions)} → ${size(event.afterDimensions)}`,
      "🖼️ Pixel percentage unavailable; the new capture becomes baseline.",
    );
  } else if (event.visualChanged && !state) {
    lines.push(`🖼️ Visual difference: ${formatPercent(event.percent ?? "0")}%`);
  }
  if (event.checkedAt) {
    const date = new Date(event.checkedAt);
    if (Number.isFinite(date.getTime())) {
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).formatToParts(date);
      const part = (name: string) => parts.find((p) => p.type === name)?.value;
      lines.push(
        `🕒 Checked: ${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")} (${timezone})`,
      );
    }
  }
  if ((event.attempt ?? 1) > 1)
    lines.push(`🔄 Notification retry: ${event.attempt}/5`);
  try {
    const url = new URL(event.link);
    if (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.href.length <= 512
    )
      lines.push(`🔗 Open monitor: ${url.href}`);
  } catch {}
  return truncateText(lines.join("\n"), 4000);
}
export function emailHTML(e: EventMessage) {
  return `<h1>${escapeHTML(e.name)}</h1>${e.attentionState ? `<p>${escapeHTML(e.attentionState.replaceAll("_", " "))}: ${escapeHTML(e.attentionMessage ?? "Requires attention")}</p>` : ""}${e.textChanged ? `<h2>Text changes</h2><pre>${escapeHTML(e.textSummary)}</pre>` : ""}${e.visualChanged ? `<p>${escapeHTML(visualSummary(e))}</p>` : ""}<p><a href="${escapeHTML(e.link)}">Open monitor</a></p>${e.images.length ? "<p>Before, after and available diff images are attached.</p>" : ""}`;
}
export type TelegramSend = (
  token: string,
  method: string,
  body: Buffer,
  contentType: string,
) => Promise<void>;
export type TelegramValidate = (
  token: string,
) => Promise<{ first_name: string; username?: string }>;
export const telegramValidate: TelegramValidate = async (token) => {
  const t = await new EgressPolicy().target("https://api.telegram.org");
  return await new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${token}/getMe`,
        method: "POST",
        signal: AbortSignal.timeout(15000),
        lookup: (_h, opts, cb: any) =>
          opts.all
            ? cb(null, [{ address: t.address, family: t.family }])
            : cb(null, t.address, t.family),
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
          if (data.length > 100000) req.destroy(Error("Provider response too large"));
        });
        res.on("end", () => {
          try {
            const body = JSON.parse(data);
            if (res.statusCode === 200 && body.ok && typeof body.result?.first_name === "string")
              resolve({ first_name: truncateText(body.result.first_name, 120), username: typeof body.result.username === "string" ? truncateText(body.result.username, 120) : undefined });
            else reject(Error("Telegram validation failed"));
          } catch {
            reject(Error("Telegram validation failed"));
          }
        });
      },
    );
    req.setTimeout(15000, () => req.destroy(Error("Provider timed out")));
    req.on("error", () => reject(Error("Telegram validation failed")));
    req.end();
  });
};
export const telegramSend: TelegramSend = async (
  token,
  method,
  body,
  contentType,
) => {
  const t = await new EgressPolicy().target("https://api.telegram.org");
  await new Promise<void>((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${token}/${method}`,
        method: "POST",
        signal: AbortSignal.timeout(15000),
        lookup: (_h, opts, cb: any) =>
          opts.all
            ? cb(null, [{ address: t.address, family: t.family }])
            : cb(null, t.address, t.family),
        headers: { "Content-Type": contentType, "Content-Length": body.length },
      },
      (res) => {
        let data = "";
        res.on("data", (b) => {
          data += b;
          if (data.length > 100000)
            req.destroy(Error("Provider response too large"));
        });
        res.on("error", () => reject(Error("Telegram delivery failed")));
        res.on("end", () => {
          try {
            if (res.statusCode === 200 && JSON.parse(data).ok) resolve();
            else reject(Error("Telegram delivery failed"));
          } catch {
            reject(Error("Telegram delivery failed"));
          }
        });
      },
    );
    req.setTimeout(15000, () => req.destroy(Error("Provider timed out")));
    req.on("error", () => reject(Error("Telegram delivery failed")));
    req.end(body);
  });
};
export async function deliver(
  provider: string,
  config: any,
  event: EventMessage,
  storage: Storage,
  deps: {
    smtp?: typeof nodemailer.createTransport;
    telegram?: TelegramSend;
    policy?: EgressPolicy;
  } = {},
) {
  const candidates = await Promise.all(
    event.images.slice(0, 3).map(async (name, i) => ({
      filename:
        (event.imageLabels?.[i] ?? ["before", "after", "diff"][i]) + ".png",
      content: await storage.read(name),
    })),
  );
  // Omit oversized images instead of sending partial/corrupt PNGs; total attachments <= 8 MiB.
  let bytes = 0;
  const files = candidates.filter((f) => {
    if (
      f.content.length > 4 * 1024 * 1024 ||
      bytes + f.content.length > 8 * 1024 * 1024
    )
      return false;
    bytes += f.content.length;
    return true;
  });
  if (provider === "smtp") {
    const c = smtpSchema.parse(config);
    const t = await (
      deps.policy ?? new EgressPolicy(undefined, undefined, new Set([465, 587]))
    ).target(`https://${c.host}:${c.port}`);
    const transport = (deps.smtp ?? nodemailer.createTransport)({
      host: t.address,
      port: c.port,
      secure: c.port === 465,
      requireTLS: true,
      auth: c.username ? { user: c.username, pass: c.password } : undefined,
      tls: { rejectUnauthorized: true, servername: c.host },
      connectionTimeout: 15000,
      socketTimeout: 15000,
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        transport.sendMail({
          from: c.from,
          to: c.to,
          subject: `Changd Fusion: ${event.name}`,
          text: summary(event),
          html: emailHTML(event),
          attachments: files,
          messageId: `<${event.id}@changd-fusion.example.com>`,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(Error("SMTP delivery timed out")),
            45000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      transport.close();
    }
  } else if (provider === "telegram") {
    const c = telegramSchema.parse(config),
      send = deps.telegram ?? telegramSend;
    await send(
      c.token,
      "sendMessage",
      Buffer.from(
        JSON.stringify({
          chat_id: c.chat_id,
          text: telegramSummary(event, c.timezone),
          link_preview_options: { is_disabled: true },
        }),
      ),
      "application/json",
    );
    // Telegram photo limits also constrain dimensions/aspect ratio, even for small compressed PNGs.
    const photos = files.filter((f) => {
      const { width, height } = pngDimensions(f.content);
      return (
        width + height <= 10_000 &&
        Math.max(width, height) / Math.min(width, height) <= 20
      );
    });
    const documents = files.filter((f) => !photos.includes(f));
    const sendFile = async (f: (typeof files)[number], asDocument = false) => {
      const boundary = "fusion-" + randomUUID();
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${c.chat_id}\r\n--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${telegramEnglish.captions[f.filename]}\r\n--${boundary}\r\nContent-Disposition: form-data; name="${asDocument ? "document" : "photo"}"; filename="${f.filename}"\r\nContent-Type: image/png\r\n\r\n`,
        ),
        f.content,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      await send(
        c.token,
        asDocument ? "sendDocument" : "sendPhoto",
        body,
        `multipart/form-data; boundary=${boundary}`,
      );
    };
    if (photos.length === 1) await sendFile(photos[0]);
    else if (photos.length > 1) {
      // One album request keeps the before/after/diff images together.
      const boundary = "fusion-" + randomUUID();
      const parts: Buffer[] = [];
      const field = (name: string, value: string) =>
        parts.push(
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
          ),
        );
      field("chat_id", c.chat_id);
      field(
        "media",
        JSON.stringify(
          photos.map((f, i) => ({
            type: "photo",
            media: `attach://image${i}`,
            caption: telegramEnglish.captions[f.filename],
          })),
        ),
      );
      photos.forEach((f, i) =>
        parts.push(
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="image${i}"; filename="${f.filename}"\r\nContent-Type: image/png\r\n\r\n`,
          ),
          f.content,
          Buffer.from("\r\n"),
        ),
      );
      parts.push(Buffer.from(`--${boundary}--\r\n`));
      await send(
        c.token,
        "sendMediaGroup",
        Buffer.concat(parts),
        `multipart/form-data; boundary=${boundary}`,
      );
    }
    for (const file of documents) await sendFile(file, true);
  } else throw Error("Unsupported provider");
}
