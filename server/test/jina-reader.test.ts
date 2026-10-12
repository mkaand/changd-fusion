import { test } from "node:test";
import assert from "node:assert/strict";
import { validateJinaReaderContent } from "../src/capture.js";

test("Jina Reader rejects compact challenge and access interstitials without blocking normal articles", () => {
  for (const body of ["Just a moment... Performing security verification", "Cloudflare challenge: access denied", "Error 1020: Access denied"]) assert.throws(() => validateJinaReaderContent(Buffer.from(body)));
  const article = "CAPTCHA research is discussed in this long article. ".repeat(20);
  assert.equal(validateJinaReaderContent(Buffer.from(article)), article.trim());
});
