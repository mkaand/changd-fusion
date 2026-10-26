import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EgressPolicy,
  publicAddress,
  safeFetch,
  browserProxy,
} from "../src/egress.js";
import http from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { encrypt, decrypt } from "../src/crypto.js";
import { randomBytes } from "node:crypto";
import { Storage } from "../src/storage.js";
import { mkdtemp, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
test("browser proxy handles CONNECT cancellation during DNS validation", async () => {
  let startLookup!: () => void, finishLookup!: () => void;
  const started = new Promise<void>((resolve) => { startLookup = resolve; });
  const gate = new Promise<void>((resolve) => { finishLookup = resolve; });
  const proxy = await browserProxy(new EgressPolicy(async () => {
    startLookup();
    await gate;
    return [{ address: "127.0.0.1", family: 4 }];
  }, () => true));
  const client = net.connect(Number(new URL(proxy.url).port), "127.0.0.1");
  client.on("error", () => {});
  try {
    await new Promise<void>((resolve) => client.once("connect", resolve));
    client.write("CONNECT fixture.test:443 HTTP/1.1\r\nHost: fixture.test:443\r\n\r\n");
    await started;
    await new Promise<void>((resolve) => { client.once("close", resolve); client.resetAndDestroy(); });
    finishLookup();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally { finishLookup(); client.destroy(); await proxy.close(); }
});
test("browser proxy contains an interrupted upstream response without uncaught socket errors", async () => {
  const fixture = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Length": "1000" });
    res.write("synthetic");
    setTimeout(() => res.destroy(), 20);
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const port = (fixture.address() as AddressInfo).port;
  const proxy = await browserProxy(new EgressPolicy(async () => [{ address: "127.0.0.1", family: 4 }], () => true, new Set([port])));
  try {
    await new Promise<void>((resolve, reject) => {
      const request = http.get(proxy.url, { path: `http://fixture.test:${port}/` }, (response) => {
        response.on("data", () => {});
        response.on("error", () => resolve());
        response.on("end", resolve);
      });
      request.on("error", () => resolve());
      request.setTimeout(1000, () => { request.destroy(); reject(Error("Proxy did not close the interrupted response")); });
    });
  } finally {
    await proxy.close();
    fixture.closeAllConnections();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  }
});
test("private, mapped IPv6, link-local, multicast and metadata addresses are blocked", () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "192.0.2.1",
  ])
    assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress("8.8.8.8"), true);
});
test("DNS mixes, credential URLs, protocols and arbitrary ports are blocked", async () => {
  const policy = new EgressPolicy(async () => [
    { address: "8.8.8.8", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ]);
  for (const url of [
    "http://example.com",
    "file:///etc/passwd",
    "http://user:password@example.com",
    "http://example.com:8000",
    "http://2130706433",
    "http://[::ffff:127.0.0.1]",
    "http://localhost.",
  ])
    await assert.rejects(policy.target(url));
  await assert.rejects(
    new EgressPolicy(async () => {
      throw Error("synthetic-private-resolver-detail");
    }).target("https://example.com"),
    (error) =>
      error instanceof Error && error.message === "DNS resolution failed",
  );
});
test("redirects are revalidated and browser proxy refuses private subresources", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(302, { location: "http://169.254.169.254/" });
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const policy = new EgressPolicy(
    async () => [{ address: "127.0.0.1", family: 4 }],
    (ip) => ip === "127.0.0.1",
    new Set([port, 80, 443]),
  );
  try {
    await assert.rejects(safeFetch(`http://fixture.test:${port}`, policy));
    const proxy = await browserProxy(new EgressPolicy());
    try {
      const status = await new Promise<number>((r) =>
        http.get(proxy.url, { path: "http://169.254.169.254/" }, (res) => {
          res.resume();
          r(res.statusCode!);
        }),
      );
      assert.equal(status, 403);
    } finally {
      await proxy.close();
    }
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("Jina no-cache is fixed to Reader requests and is not forwarded across redirects", async () => {
  const received: { host: string; noCache?: string }[] = [];
  const server = http.createServer((req, res) => {
    received.push({ host: req.headers.host ?? "", noCache: req.headers["x-no-cache"] });
    if (req.headers.host?.startsWith("r.jina.ai")) {
      res.writeHead(302, { location: `http://other.test:${(server.address() as AddressInfo).port}/final` });
      res.end();
      return;
    }
    res.end("fixture");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const policy = new EgressPolicy(
    async () => [{ address: "127.0.0.1", family: 4 }],
    (ip) => ip === "127.0.0.1",
    new Set([port, 80, 443]),
  );
  try {
    await safeFetch(`http://r.jina.ai:${port}/reader`, policy, 30000, 2_000_000, { jinaNoCache: true });
    assert.deepEqual(received, [
      { host: `r.jina.ai:${port}`, noCache: "true" },
      { host: `other.test:${port}`, noCache: undefined },
    ]);
    received.length = 0;
    await safeFetch(`http://r.jina.ai:${port}/reader`, policy);
    assert.equal(received[0]?.noCache, undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test("credentials use authenticated encryption and tampering is rejected", () => {
  const key = randomBytes(32).toString("hex"),
    enc = encrypt({ token: "synthetic-fixture" }, key);
  assert.equal(decrypt(enc, key).token, "synthetic-fixture");
  assert.ok(!enc.includes("synthetic-fixture"));
  assert.throws(() => decrypt(enc, randomBytes(32).toString("hex")));
});
test("artifact traversal and escaping symlinks are rejected", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fusion-storage-")),
    store = new Storage(root);
  try {
    await assert.rejects(store.read("../secret"));
    const name = await store.save(Buffer.from("fixture"));
    assert.equal((await store.read(name)).toString(), "fixture");
    await symlink(
      "/etc/hosts",
      path.join(root, "00000000-0000-0000-0000-000000000000.png"),
    );
    await assert.rejects(
      store.file("00000000-0000-0000-0000-000000000000.png"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
