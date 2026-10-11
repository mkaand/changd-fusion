import test from "node:test";
import assert from "node:assert/strict";
import {
  CaptureFailure,
  HttpError,
  captureFailure,
  publicFailure,
} from "../src/errors.js";

test("capture failure diagnostics classify only safe signals", () => {
  const secret = "bot-token=123456:secret cookie=private url=https://example.test/?secret=hidden";
  const cases: Array<[Error, any, string]> = [
    [new Error(`Timeout while navigating ${secret}`), "navigation", "timeout"],
    [new Error(`getaddrinfo ENOTFOUND ${secret}`), "navigation", "dns_failure"],
    [new Error(`TLS certificate rejected ${secret}`), "navigation", "tls_failure"],
    [new Error(`ECONNRESET ${secret}`), "navigation", "connection_failure"],
    [new Error(`browser closed ${secret}`), "browser_launch", "browser_crashed"],
    [new Error(`arbitrary ${secret}`), "navigation", "navigation_failed"],
  ];
  for (const [error, stage, expected] of cases) {
    const diagnostic = captureFailure(error, stage);
    assert.equal(diagnostic.code, expected);
    assert.equal(diagnostic.stage, stage);
    assert.ok(!JSON.stringify(diagnostic).includes(secret));
    assert.ok(!publicFailure(diagnostic).includes(secret));
  }
});

test("capture deadlines are retained as safe timeout diagnostics", () => {
  const diagnostic = new CaptureFailure("attention_detection", "timeout");
  assert.deepEqual(
    { stage: diagnostic.stage, code: diagnostic.code, status: diagnostic.httpStatus },
    { stage: "attention_detection", code: "timeout", status: null },
  );
  assert.equal(publicFailure(diagnostic), "Website capture failed. Check monitor diagnostics.");
});

test("safe HTTP classification retains only controlled HTTP diagnostics", () => {
  const forbidden = captureFailure(new HttpError(403, "Access denied (HTTP 403)"), "navigation");
  assert.deepEqual(
    { stage: forbidden.stage, code: forbidden.code, status: forbidden.httpStatus },
    { stage: "navigation", code: "http_403", status: 403 },
  );
  const rateLimited = captureFailure(new HttpError(429, "Rate limited (HTTP 429)"), "navigation");
  assert.equal(rateLimited.code, "http_429");
  const server = captureFailure(new HttpError(502, "Upstream server failed (HTTP 502)"), "navigation");
  assert.equal(server.code, "http_5xx");
  const egress = captureFailure(new HttpError(400, "URL not permitted: https://example.test/?token=hidden"), "target_validation");
  assert.equal(egress.code, "egress_denied");
  assert.ok(!egress.message.includes("token"));
  assert.equal(
    captureFailure(new HttpError(400, "DNS resolution timed out"), "target_validation").code,
    "dns_failure",
  );
  assert.equal(
    captureFailure(new HttpError(422, "Browser workflow exceeded its time budget"), "browser_steps").code,
    "timeout",
  );
});

test("public capture failures never expose raw causes", () => {
  const diagnostic = new CaptureFailure("screenshot", "resource_limit");
  assert.equal(publicFailure(diagnostic), "Website capture failed. Check monitor diagnostics.");
  assert.equal(
    publicFailure(new Error("password=unsafe-token")),
    "Operation failed. Check configuration and retry.",
  );
});
