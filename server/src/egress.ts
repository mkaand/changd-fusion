import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { AddressInfo } from "node:net";
import ipaddr from "ipaddr.js";
import { HttpError } from "./errors.js";
export type Address = { address: string; family: number };
export function publicAddress(value: string): boolean {
  try {
    const ip = ipaddr.process(value);
    return ip.range() === "unicast";
  } catch {
    return false;
  }
}
export class EgressPolicy {
  constructor(
    private resolve: (host: string) => Promise<Address[]> = (host) =>
      dns.lookup(host, { all: true, verbatim: true }),
    private allowed: (ip: string) => boolean = publicAddress,
    private ports: ReadonlySet<number> = new Set([80, 443]),
  ) {}
  private async lookup(hostname: string) {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.resolve(hostname),
        new Promise<Address[]>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new HttpError(400, "DNS resolution timed out")),
            5000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async target(input: string) {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new HttpError(400, "Invalid URL");
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      !this.ports.has(
        Number(url.port || (url.protocol === "https:" ? 443 : 80)),
      )
    )
      throw new HttpError(400, "URL is not permitted");
    if (
      /(^|\.)(localhost|local|internal|home|lan)$|\.localhost\.$/i.test(
        hostname,
      )
    )
      throw new HttpError(400, "Private destinations are blocked");
    const addresses = net.isIP(hostname)
      ? [{ address: hostname, family: net.isIP(hostname) }]
      : await this.lookup(hostname);
    if (!addresses.length || addresses.some((a) => !this.allowed(a.address)))
      throw new HttpError(400, "Private destinations are blocked");
    return { url, hostname, ...addresses[0] };
  }
}
export async function safeFetch(
  input: string,
  policy: EgressPolicy,
  timeout = 30000,
  maxBytes = 2_000_000,
): Promise<{ body: Buffer; contentType: string }> {
  const deadline = Date.now() + timeout;
  for (let hop = 0; hop < 6; hop++) {
    const target = await policy.target(input);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw Error("Capture timed out");
    const result = await new Promise<{
      status: number;
      location?: string;
      body: Buffer;
      contentType: string;
    }>((resolve, reject) => {
      const client = target.url.protocol === "https:" ? https : http;
      // Pin the validated address at connect time; TLS still validates the original hostname.
      const req = client.request(
        target.url,
        {
          lookup: (_h, opts, cb: any) =>
            opts.all
              ? cb(null, [{ address: target.address, family: target.family }])
              : cb(null, target.address, target.family),
          headers: {
            "User-Agent": "Changd-Fusion/0.2",
            Accept: "application/json,text/html",
          },
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (b: Buffer) => {
            size += b.length;
            if (size > maxBytes) {
              req.destroy(Error("Response too large"));
              return;
            }
            chunks.push(b);
          });
          res.on("error", reject);
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 500,
              location: res.headers.location,
              body: Buffer.concat(chunks),
              contentType: res.headers["content-type"] ?? "",
            }),
          );
        },
      );
      const timer = setTimeout(
        () => req.destroy(Error("Capture timed out")),
        remaining,
      );
      req.on("close", () => clearTimeout(timer));
      req.on("error", reject);
      req.end();
    });
    if ([301, 302, 303, 307, 308].includes(result.status) && result.location) {
      input = new URL(result.location, target.url).href;
      continue;
    }
    if (result.status < 200 || result.status >= 300)
      throw Error("Target returned an unsuccessful response");
    return result;
  }
  throw new HttpError(400, "Too many redirects");
}
// All browser traffic, including redirects, subresources and WebSockets, uses this proxy.
// DNS validation occurs at connection time and sockets connect to the validated IP.
export async function browserProxy(policy: EgressPolicy) {
  const sockets = new Set<net.Socket>();
  let closed = false;
  const server = http.createServer(async (req, res) => {
    try {
      const t = await policy.target(req.url ?? "");
      if (closed || res.destroyed) return;
      if (t.url.protocol !== "http:") throw Error("Invalid proxy request");
      const upstream = http.request(
        {
          host: t.address,
          port: t.url.port || 80,
          path: t.url.pathname + t.url.search,
          method: req.method,
          headers: { ...req.headers, host: t.url.host },
          agent: false,
        },
        (r) => {
          res.writeHead(r.statusCode ?? 502, r.headers);
          r.pipe(res);
        },
      );
      upstream.setTimeout(30000, () => upstream.destroy());
      upstream.on("socket", (s) => {
        sockets.add(s);
        s.on("close", () => sockets.delete(s));
      });
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    } catch {
      res.writeHead(403);
      res.end("Destination blocked");
    }
  });
  server.on("connect", async (req, client, head) => {
    try {
      const t = await policy.target("https://" + req.url);
      if (closed || client.destroyed) return;
      const upstream = net.connect({
        host: t.address,
        port: Number(t.url.port || 443),
      });
      sockets.add(upstream);
      upstream.on("close", () => sockets.delete(upstream));
      upstream.setTimeout(30000, () => upstream.destroy());
      upstream.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
      client.on("close", () => upstream.destroy());
    } catch {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      closed = true;
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
