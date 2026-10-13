import { test } from "node:test";
import assert from "node:assert/strict";
import { jinaReaderFetchOptions, shouldBypassJinaCache } from "../src/capture.js";
import { jinaTextPreviewFetchOptions } from "../src/text-picker.js";

test("only Jina Selected Text scheduled captures opt into the Reader no-cache policy", () => {
  assert.equal(shouldBypassJinaCache({ text_source: "jina", extraction_mode: "selected_text" }), true);
  assert.deepEqual(jinaReaderFetchOptions({ text_source: "jina", extraction_mode: "selected_text" }), { jinaNoCache: true });
  assert.deepEqual(jinaTextPreviewFetchOptions, { jinaNoCache: true });
  for (const monitor of [
    { text_source: "jina", extraction_mode: "full_text" },
    { text_source: "jina", extraction_mode: "product_price" },
    { text_source: "direct", extraction_mode: "selected_text" },
    { text_source: undefined, extraction_mode: undefined },
  ] as const)
    assert.equal(shouldBypassJinaCache(monitor), false);
  assert.deepEqual(jinaReaderFetchOptions({ text_source: "jina", extraction_mode: "full_text" }), { jinaNoCache: false });
});
