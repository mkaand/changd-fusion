import { test } from "node:test";
import assert from "node:assert/strict";
import { jinaReaderText } from "../src/jina-reader.js";

test("Jina Reader accepts only its documented content envelope", () => {
  assert.equal(jinaReaderText(JSON.stringify({ data: { content: "safe reader text" } })), "safe reader text");
  assert.equal(jinaReaderText("# ordinary markdown"), "# ordinary markdown");
  assert.equal(jinaReaderText('{"unexpected":true}'), '{"unexpected":true}');
});
