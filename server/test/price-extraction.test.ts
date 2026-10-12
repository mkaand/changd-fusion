import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalProductPrice, extractProductPrice, jinaReaderText } from "../src/price-extraction.js";

test("reads supported Jina JSON and Turkish product selling prices", () => {
  const markdown = "# GMKtec G3 Plus N150\n\nListe fiyatı: ~~35.999,00 TL~~\n\nSatış fiyatı: **32.999,00 TL**\n\n12 taksit x 2.749,92 TL\nÜcretsiz kargo";
  assert.equal(jinaReaderText(JSON.stringify({ data: { content: markdown } })), markdown);
  assert.deepEqual(extractProductPrice(markdown), { currency: "TRY", amount: "32999.00", display: "32.999,00 TL" });
  assert.equal(canonicalProductPrice(extractProductPrice(markdown)), "Product price: TRY 32999.00");
});

test("rejects missing and ambiguous selling prices instead of choosing arbitrarily", () => {
  assert.throws(() => extractProductPrice("No price is currently available"), /could not be identified/);
  assert.throws(() => extractProductPrice("Satış fiyatı: 10.000,00 TL\nÜrün fiyatı: 11.000,00 TL"), /ambiguous/);
});

test("ignores crossed-out, installment, shipping and suggested-product amounts", () => {
  const content = "~~40.000,00 TL~~\nKargo: 99,90 TL\n12 taksit x 2.750,00 TL\nSatış fiyatı: 32.999,00 TL\nÖnerilen ürün 2.499,00 TL";
  assert.equal(extractProductPrice(content).amount, "32999.00");
});

test("normalizes equivalent Turkish price representations to a stable value", () => {
  assert.equal(extractProductPrice("Fiyat: 32.999,00 TL").amount, "32999.00");
  assert.equal(extractProductPrice("Fiyat: 32999,00 TRY").amount, "32999.00");
  assert.equal(extractProductPrice("Fiyat: 32.999 ₺").amount, "32999.00");
});
