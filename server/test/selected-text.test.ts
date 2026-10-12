import assert from "node:assert/strict";
import test from "node:test";
import { applySelectedTextRule, generateSelectedTextRule, readableJinaLines } from "../src/selected-text.js";

test("selected text rules track arbitrary changing values without hardcoding the original", () => {
  const first = readableJinaLines("GMKtec G3 Plus\nPrice today\n32.999,00 TL\nSeller: Teknobiyotik");
  const generated = generateSelectedTextRule(first, 2, "32.999,00 TL");
  assert.equal(generated.extracted, "32.999,00 TL");
  const changed = readableJinaLines("GMKtec G3 Plus\nPrice today\n31.499,00 TL\nSeller: Teknobiyotik").join("\n");
  assert.equal(applySelectedTextRule(changed, generated.rule), "31.499,00 TL");
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
});
