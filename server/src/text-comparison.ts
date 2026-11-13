import { diffLines } from "diff";

export function normalizeText(
  text: string,
  options: {
    ignore_text: string[];
    normalize_whitespace: boolean;
    ignore_case: boolean;
  },
) {
  // Literal ignore strings avoid user-controlled catastrophic regular expressions.
  for (const value of options.ignore_text)
    if (value) text = text.split(value).join("");
  if (options.normalize_whitespace) text = text.replace(/\s+/g, " ").trim();
  if (options.ignore_case) text = text.toLocaleLowerCase("en-US");
  return text;
}
export function compareText(before: string, after: string) {
  const unchanged = before === after;
  return {
    changed: !unchanged,
    // Preserve diffLines' legacy neutral entry for equal non-empty text without
    // paying its CPU cost; equal empty text has always produced no entries.
    parts: (unchanged ? (before ? [{ value: before, added: false, removed: false }] : []) : diffLines(before, after)).map(({ value, added, removed }) => ({
      value,
      added: !!added,
      removed: !!removed,
    })),
  };
}

const wordCharacter = /[\p{L}\p{M}\p{N}_]/u;

function folded(value: string) {
  // Unicode default lower-casing expands capital dotted I to `i` + combining
  // dot. Collapse that equivalent form so Turkish text matches the literal
  // lowercase spelling without making unrelated accents insensitive.
  return value.normalize("NFKC").toLocaleLowerCase("und").replace(/i\u0307/g, "i");
}

function edgeCharacter(value: string, edge: "first" | "last") {
  const characters = Array.from(value);
  return edge === "first" ? characters[0] : characters.at(-1);
}

/**
 * Matches a literal Unicode word or phrase. The monitor keyword is never
 * evaluated as a regular expression, and matches embedded in a larger word
 * are rejected.
 */
export function containsKeyword(text: string, keyword: string) {
  const haystack = folded(text);
  const needle = folded(keyword.trim());
  if (!needle) return false;
  let offset = 0;
  while (offset <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, offset);
    if (index < 0) return false;
    const before = edgeCharacter(haystack.slice(0, index), "last");
    const after = edgeCharacter(haystack.slice(index + needle.length), "first");
    if ((!before || !wordCharacter.test(before)) && (!after || !wordCharacter.test(after)))
      return true;
    offset = index + Math.max(1, needle.length);
  }
  return false;
}

export function compareKeywordPresence(before: string, after: string, keyword: string) {
  const wasPresent = containsKeyword(before, keyword);
  const isPresent = containsKeyword(after, keyword);
  if (wasPresent === isPresent) return { changed: false, parts: [] };
  return {
    changed: true,
    parts: [{
      value: keyword,
      added: isPresent,
      removed: wasPresent,
    }],
  };
}
