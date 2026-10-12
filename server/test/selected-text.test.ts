import assert from "node:assert/strict";
import test from "node:test";
import { applySelectedTextRule, generateSelectedTextRule, readableJinaLines, readableJinaPreview } from "../src/selected-text.js";

test("selected text rules track arbitrary changing values without hardcoding the original", () => {
  const first = readableJinaLines("GMKtec G3 Plus\nPrice today\n32.999,00 TL\nSeller: Teknobiyotik");
  const generated = generateSelectedTextRule(first, 2, "32.999,00 TL");
  assert.equal(generated.extracted, "32.999,00 TL");
  const changed = readableJinaLines("GMKtec G3 Plus\nPrice today\n31.499,00 TL\nSeller: Teknobiyotik").join("\n");
  assert.equal(applySelectedTextRule(changed, generated.rule), "31.499,00 TL");
});

test("Reader preview reports its bounded line window instead of silently hiding truncation", () => {
  const preview = readableJinaPreview(Array.from({ length: 2001 }, (_, index) => `Line ${index}`).join("\n"));
  assert.equal(preview.lines.length, 2000);
  assert.equal(preview.totalLines, 2001);
  assert.equal(preview.truncated, true);
});

test("selected text rules require one target occurrence even when duplicate values are identical", () => {
  const rule = { version: 1 as const, kind: "bounded_context" as const, before: "Availability\n", after: "\nDelivery", max_length: 64 };
  assert.equal(applySelectedTextRule("Availability\nIn stock\nDelivery", rule), "In stock");
  assert.throws(
    () => applySelectedTextRule("Availability\nIn stock\nDelivery\nAvailability\nIn stock\nDelivery", rule),
    /ambiguous/,
  );
  assert.throws(
    () => applySelectedTextRule("Availability\nIn stock\nDelivery\nAvailability\nBack ordered\nDelivery", rule),
    /ambiguous/,
  );
});

test("selected text rules support ordinary text and fail closed when context becomes ambiguous", () => {
  const lines = readableJinaLines("Product\nAvailability\nIn stock\nDelivery");
  const generated = generateSelectedTextRule(lines, 2, "In stock");
  assert.equal(applySelectedTextRule("Product\nAvailability\nBack ordered\nDelivery", generated.rule), "Back ordered");
  assert.throws(() => applySelectedTextRule("Product\nAvailability\nA\nDelivery\nProduct\nAvailability\nB\nDelivery", generated.rule), /ambiguous/);
});

test("selected text rules reject missing context and excessive values", () => {
  assert.throws(() => generateSelectedTextRule(["Only value"], 0, "Only value"), /stable rule/);
  assert.throws(() => generateSelectedTextRule(["Before", "x".repeat(501), "After"], 1, "x".repeat(501)), /500/);
  assert.throws(
    () => applySelectedTextRule("Other\nIn stock\nDelivery", { version: 1, kind: "bounded_context", before: "Availability\n", after: "\nDelivery", max_length: 64 }),
    /could not be found/,
  );
  assert.equal(
    applySelectedTextRule(`Before${"x".repeat(500)}After`, { version: 1, kind: "bounded_context", before: "Before", after: "After", max_length: 500 }),
    "x".repeat(500),
  );
  assert.throws(
    () => applySelectedTextRule(`Before${"x".repeat(501)}After`, { version: 1, kind: "bounded_context", before: "Before", after: "After", max_length: 500 }),
    /could not be found/,
  );
});
