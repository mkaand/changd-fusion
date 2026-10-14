import assert from "node:assert/strict";
import test from "node:test";
import { applySelectedTextRule, generateSelectedTextRule, readableJinaLines, readableJinaPreview, searchJinaLines } from "../src/selected-text.js";

test("selected text rules track arbitrary changing values without hardcoding the original", () => {
  const first = readableJinaLines("GMKtec G3 Plus\nPrice today\n32.999,00 TL\nSeller: Teknobiyotik");
  const generated = generateSelectedTextRule(first, 2, "32.999,00 TL");
  assert.equal(generated.extracted, "32.999,00 TL");
  const changed = readableJinaLines("GMKtec G3 Plus\nPrice today\n31.499,00 TL\nSeller: Teknobiyotik").join("\n");
  assert.equal(applySelectedTextRule(changed, generated.rule), "31.499,00 TL");
});

test("Reader preview keeps accepted content available while paging bounded results", () => {
  const preview = readableJinaPreview(Array.from({ length: 2001 }, (_, index) => `Line ${index}`).join("\n"));
  assert.equal(preview.lines.length, 2001);
  assert.equal(preview.totalLines, 2001);
  const page = searchJinaLines(preview.lines, "Line 2000");
  assert.deepEqual(page.items, [{ index: 2000, text: "Line 2000" }]);
  assert.equal(page.matching_line_count, 1);
});

test("Reader search is Turkish-aware, bounded, and retains original indexes beyond the display page", () => {
  const lines = Array.from({ length: 2_101 }, (_, index) => `Satır ${index}`);
  lines[2_050] = "İstanbul teslimat";
  lines[2_099] = "İSTANBUL stok durumu";
  const found = searchJinaLines(lines, "istanbul");
  assert.deepEqual(found.items.map((item) => item.index), [2050, 2099]);
  assert.equal(found.total_line_count, 2101);
  const capped = searchJinaLines(Array.from({ length: 150 }, (_, index) => `same ${index}`));
  assert.equal(capped.items.length, 100);
  assert.equal(capped.has_more, true);
});

test("selected rules generated after line 2,000 use the full Reader content during scheduled extraction", () => {
  const lines = Array.from({ length: 2_005 }, (_, index) => `Line ${index}`);
  lines[2003] = "Availability";
  lines[2004] = "In stock";
  const rule = generateSelectedTextRule(lines, 2004, "In stock");
  assert.equal(applySelectedTextRule(lines.join("\n"), rule.rule), "In stock");
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

test("dynamic price changes keep the selected value anchored without matching the old value", () => {
  const rule = generateSelectedTextRule(readableJinaLines("Hepsiburada\nPrice today\n32.999,00 TL\nSeller: Store"), 2, "32.999,00 TL").rule;
  assert.equal(applySelectedTextRule("Hepsiburada\nPrice today\n33.999,00 TL\nSeller: Store", rule), "33.999,00 TL");
});

test("a changed neighbouring Reader line keeps a V2 selection anchored by independent lines", () => {
  const rule = generateSelectedTextRule(readableJinaLines("Product\nPrice today\n32.999,00 TL\nSeller: Store"), 2, "32.999,00 TL").rule;
  assert.equal(applySelectedTextRule("Product\nCurrent offer\n33.999,00 TL\nSeller: Store", rule), "33.999,00 TL");
  assert.equal(applySelectedTextRule("Product\nPrice today\n33.999,00 TL\nMerchant: Store", rule), "33.999,00 TL");
});

test("stored V1 bounded-context rules remain backward compatible and fail closed", () => {
  const legacy = { version: 1 as const, kind: "bounded_context" as const, before: "Availability\n", after: "\nDelivery", max_length: 64 };
  assert.equal(applySelectedTextRule("Availability\nBack ordered\nDelivery", legacy), "Back ordered");
  assert.throws(() => applySelectedTextRule("Other\nBack ordered\nDelivery", legacy), /could not be found/);
});

test("unrelated Reader line additions do not change a uniquely bounded selection", () => {
  const rule = generateSelectedTextRule(readableJinaLines("Product\nPrice today\n32.999,00 TL\nSeller: Store"), 2, "32.999,00 TL").rule;
  const current = "Reader announcement\nProduct\nPrice today\n33.999,00 TL\nSeller: Store\nUpdated delivery details";
  assert.equal(applySelectedTextRule(current, rule), "33.999,00 TL");
});

test("repeated price-like values and competing contexts fail closed instead of picking a candidate", () => {
  const rule = generateSelectedTextRule(readableJinaLines("Price\n32.999,00 TL\nDelivery"), 1, "32.999,00 TL").rule;
  assert.throws(
    () => applySelectedTextRule("Price\n33.999,00 TL\nDelivery\nPrice\n1.999,00 TL\nDelivery", rule),
    /ambiguous/,
  );
});

test("missing selected text remains an extraction failure", () => {
  const rule = generateSelectedTextRule(readableJinaLines("Product\nAvailability\nIn stock\nDelivery"), 2, "In stock").rule;
  assert.throws(() => applySelectedTextRule("Product\nUnavailable\nShipping delayed", rule), /could not be found/);
});

test("dynamic matching supports stock, version, Turkish characters and punctuation", () => {
  const stock = generateSelectedTextRule(readableJinaLines("Product\nAvailability\nIn stock\nDelivery"), 2, "In stock").rule;
  assert.equal(applySelectedTextRule("Product\nAvailability\nOut of stock\nDelivery", stock), "Out of stock");
  const version = generateSelectedTextRule(readableJinaLines("Downloads\nCurrent version\nVersion 1.2.3\nRelease notes"), 2, "Version 1.2.3").rule;
  assert.equal(applySelectedTextRule("Downloads\nCurrent version\nVersion 1.2.4\nRelease notes", version), "Version 1.2.4");
  const turkish = generateSelectedTextRule(readableJinaLines("Ürün bilgisi\nStok durumu\nİndirimli: çok özel!\nKargo"), 2, "İndirimli: çok özel!").rule;
  assert.equal(applySelectedTextRule("Ürün bilgisi\nStok durumu\nİndirimli: son ürün!\nKargo", turkish), "İndirimli: son ürün!");
});

test("preview generation and scheduled Reader extraction use the same normalized V1 semantics", () => {
  const previewLines = readableJinaLines("Product\r\nPrice today\r\n32.999,00 TL\r\nSeller");
  const generated = generateSelectedTextRule(previewLines, 2, "32.999,00 TL");
  const scheduledLines = readableJinaLines("Product\nPrice today\n33.999,00 TL\nSeller");
  assert.equal(applySelectedTextRule(scheduledLines.join("\n"), generated.rule), "33.999,00 TL");
});
