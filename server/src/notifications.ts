import nodemailer from "nodemailer";
import https from "node:https";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { EgressPolicy } from "./egress.js";
import { Storage } from "./storage.js";
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
export function emailHTML(e: EventMessage) {
  return `<h1>${escapeHTML(e.name)}</h1>${e.attentionState ? `<p>${escapeHTML(e.attentionState.replaceAll("_", " "))}: ${escapeHTML(e.attentionMessage ?? "Requires attention")}</p>` : ""}${e.textChanged ? `<h2>Text changes</h2><pre>${escapeHTML(e.textSummary)}</pre>` : ""}${e.visualChanged ? `<p>${escapeHTML(visualSummary(e))}</p>` : ""}<p><a href="${escapeHTML(e.link)}">Open monitor</a></p>${e.images.length ? "<p>Before, after and available diff images are attached.</p>" : ""}`;
}
export type TelegramSend = (
  token: string,
  method: string,
  body: Buffer,
  contentType: string,
) => Promise<void>;
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
      filename: ["before.png", "after.png", "diff.png"][i],
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
          text: summary(event).slice(0, 4000),
          link_preview_options: { is_disabled: true },
        }),
      ),
      "application/json",
    );
    if (files.length === 1) {
      const boundary = "fusion-" + randomUUID();
      const f = files[0];
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${c.chat_id}\r\n--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${f.filename}"\r\nContent-Type: image/png\r\n\r\n`,
        ),
        f.content,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      await send(
        c.token,
        "sendPhoto",
        body,
        `multipart/form-data; boundary=${boundary}`,
      );
    } else if (files.length > 1) {
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
          files.map((_, i) => ({ type: "photo", media: `attach://image${i}` })),
        ),
      );
      files.forEach((f, i) =>
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
  } else throw Error("Unsupported provider");
}
