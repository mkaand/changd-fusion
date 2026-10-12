import { Decimal } from "decimal.js";
import { HttpError } from "./errors.js";

export type ProductPrice = {
  currency: "TRY";
  amount: string;
  display: string;
};

/** Accept only the documented Jina JSON envelope; all other responses remain Markdown. */
export function jinaReaderText(value: string) {
  const trimmed = value.replace(/\u0000/g, "").trim();
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && typeof parsed.data?.content === "string")
      return parsed.data.content.replace(/\u0000/g, "").trim();
  } catch {
    // A Markdown response may legitimately begin with a brace.
  }
  return trimmed;
}

const MONEY = /(?<![\d.,])(\d{1,3}(?:\.\d{3})+(?:,\d{2})?|\d+(?:,\d{2})?)\s*(?:₺|(?:TL|TRY)\b)/giu;
const REJECT_CONTEXT = /(?:taksit|ayda|\/\s*ay|kargo|teslimat|kupon|puan|yorum|değerlendirme|önerilen|benzer ürün|liste fiyatı|eski fiyat|yerine|kazancınız)/i;
const SELLING_CONTEXT = /(?:satış fiyatı|ürün fiyatı|şimdi|sepette|özel fiyat|indirimli fiyat|fiyat\s*:)/i;

function amount(raw: string) {
  const normalized = raw.includes(",") || /^\d{1,3}(?:\.\d{3})+$/.test(raw)
    ? raw.replaceAll(".", "").replace(",", ".")
    : raw;
  const value = new Decimal(normalized);
  if (!value.isFinite() || value.lte(0) || value.gt("1000000000")) return null;
  return value.toDecimalPlaces(2).toFixed(2);
}

export function extractProductPrice(content: string): ProductPrice {
  const candidates: Array<{ amount: string; display: string; score: number }> = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/[*_`#[\]()]/g, " ").replace(/\s+/g, " ").trim();
    if (!line || REJECT_CONTEXT.test(line) || /~~[^~]*\d[^~]*~~/.test(rawLine)) continue;
    for (const match of line.matchAll(MONEY)) {
      const parsed = amount(match[1]);
      if (!parsed) continue;
      const installment = new RegExp(`(?:\\d+\\s*[x×]|taksit)[^\\n]{0,40}${match[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(line);
      if (installment) continue;
      candidates.push({ amount: parsed, display: match[0].trim(), score: SELLING_CONTEXT.test(line) ? 3 : line.length <= match[0].length + 24 ? 2 : 1 });
    }
  }
  if (!candidates.length) throw new HttpError(422, "A current product selling price could not be identified. The existing baseline was preserved.");
  const bestScore = Math.max(...candidates.map((candidate) => candidate.score));
  const best = candidates.filter((candidate) => candidate.score === bestScore);
  const distinct = [...new Set(best.map((candidate) => candidate.amount))];
  if (distinct.length !== 1)
    throw new HttpError(422, "The current product selling price is ambiguous. The existing baseline was preserved.");
  return { currency: "TRY", amount: distinct[0], display: best.find((candidate) => candidate.amount === distinct[0])!.display };
}

export function canonicalProductPrice(price: ProductPrice) {
  return `Product price: ${price.currency} ${price.amount}`;
}
