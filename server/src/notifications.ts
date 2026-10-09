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
  textSummary: string;
  link: string;
  images: string[];
};
export const escapeHTML = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export const formatPercent = (value: string) => value.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
export function summary(event: EventMessage) {
  return `${event.name}\n${event.textChanged ? "Text changed: " + event.textSummary + "\n" : ""}${event.visualChanged ? "Visual change: " + formatPercent(event.percent ?? "0") + "%\n" : ""}${event.link}`;
}
export function emailHTML(e: EventMessage) {
  return `<h1>${escapeHTML(e.name)}</h1>${e.textChanged ? `<h2>Text changes</h2><pre>${escapeHTML(e.textSummary)}</pre>` : ""}${e.visualChanged ? `<p>Visual change: ${escapeHTML(formatPercent(e.percent ?? "0"))}%</p>` : ""}<p><a href="${escapeHTML(e.link)}">Open monitor</a></p>${e.images.length ? "<p>Before, after and available diff images are attached.</p>" : ""}`;
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
  const files = await Promise.all(
    event.images
      .slice(0, 3)
      .map(async (name, i) => ({
        filename: ["before.png", "after.png", "diff.png"][i],
        content: await storage.read(name),
      })),
  );
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
    try {
      await transport.sendMail({
        from: c.from,
        to: c.to,
        subject: `Changd Fusion: ${event.name}`,
        text: summary(event),
        html: emailHTML(event),
        attachments: files,
        messageId: `<${event.id}@changd-fusion.example.com>`,
      });
    } finally {
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
    if (files.length) {
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
