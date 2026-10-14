import { HttpError } from "./errors.js";

export type SelectedTextRule = {
  version: 1;
  kind: "bounded_context";
  before: string;
  after: string;
  max_length: number;
};

const MAX_ANCHOR = 160;
const MAX_VALUE = 500;
export const MAX_READER_CONTENT = 200_000;
export const MAX_READER_RESULTS = 100;

function normalizedJinaLines(text: string) {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/[\t ]+/g, " ");
  if (normalized.length > MAX_READER_CONTENT) throw new HttpError(422, "Reader content is too large to preview safely.");
  return normalized.split("\n").map((line) => line.trim()).filter(Boolean);
}

export function readableJinaPreview(text: string) {
  const lines = normalizedJinaLines(text);
  return { lines, totalLines: lines.length };
}

export function readableJinaLines(text: string) { return readableJinaPreview(text).lines; }

const searchKey = (value: string) => value.toLocaleLowerCase("tr-TR");
export function searchJinaLines(lines: string[], query = "", offset = 0, limit = MAX_READER_RESULTS) {
  const needle = searchKey(query.trim());
  const safeOffset = Math.max(0, Math.trunc(offset));
  const safeLimit = Math.max(1, Math.min(MAX_READER_RESULTS, Math.trunc(limit)));
  const items: { index: number; text: string }[] = [];
  let matchingLineCount = 0;
  for (let index = 0; index < lines.length; index++) {
    if (!needle || searchKey(lines[index]).includes(needle)) {
      if (matchingLineCount >= safeOffset && items.length < safeLimit) items.push({ index, text: lines[index] });
      matchingLineCount++;
    }
  }
  return {
    items,
    matching_line_count: matchingLineCount,
    total_line_count: lines.length,
    offset: safeOffset,
    has_more: safeOffset + items.length < matchingLineCount,
  };
}

function occurrences(haystack: string, needle: string) {
  const result: number[] = [];
  if (!needle) return result;
  for (let at = haystack.indexOf(needle); at >= 0 && result.length < 3; at = haystack.indexOf(needle, at + Math.max(1, needle.length))) result.push(at);
  return result;
}

export function applySelectedTextRule(text: string, rule: SelectedTextRule) {
  if (rule.version !== 1 || rule.kind !== "bounded_context" || rule.max_length < 1 || rule.max_length > MAX_VALUE)
    throw new HttpError(422, "Selected text rule is invalid.");
  if (!rule.before && !rule.after) throw new HttpError(422, "Selected text rule has no stable context.");
  const starts = rule.before ? occurrences(text, rule.before).map((index) => index + rule.before.length) : [0];
  const matches: string[] = [];
  for (const start of starts) {
    const end = rule.after ? text.indexOf(rule.after, start) : Math.min(text.length, start + rule.max_length);
    if (end < start || end - start > rule.max_length) continue;
    const value = text.slice(start, end).trim();
    if (value) matches.push(value);
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new HttpError(422, "Selected text is ambiguous in the current Reader output.");

  // V1 rules store the previous and next Reader lines alongside any inline
  // text around the selection. The strict lookup above deliberately remains
  // first, but a changed neighbouring line must not make a unique selected
  // value disappear. Only use this fallback when a single full-line anchor
  // identifies the immediately adjacent line. It never scores candidates or
  // guesses across inserted content: competing candidates remain ambiguous.
  const lines = readableJinaLines(text);
  const beforeAnchor = rule.before.split("\n").map((line) => line.trim()).filter(Boolean).at(-1);
  const afterAnchor = rule.after.split("\n").map((line) => line.trim()).filter(Boolean).at(0);
  const candidates = new Map<number, string>();
  const addCandidate = (index: number) => {
    const value = lines[index]?.trim();
    if (value && value.length <= rule.max_length) candidates.set(index, value);
  };
  const uniqueAnchor = (anchor: string) => {
    let found = -1;
    for (let index = 0; index < lines.length; index++) {
      if (lines[index] !== anchor) continue;
      if (found !== -1) return undefined;
      found = index;
    }
    return found === -1 ? undefined : found;
  };
  if (beforeAnchor) {
    const anchor = uniqueAnchor(beforeAnchor);
    if (anchor !== undefined) addCandidate(anchor + 1);
  }
  if (afterAnchor) {
    const anchor = uniqueAnchor(afterAnchor);
    if (anchor !== undefined) addCandidate(anchor - 1);
  }
  if (candidates.size === 1) return [...candidates.values()][0];
  throw new HttpError(422, candidates.size ? "Selected text is ambiguous in the current Reader output." : "Selected text could not be found in the current Reader output.");
}

export function generateSelectedTextRule(lines: string[], lineIndex: number, selectedValue: string) {
  if (!Number.isInteger(lineIndex) || lineIndex < 0 || lineIndex >= lines.length) throw new HttpError(422, "Select a valid preview line.");
  const line = lines[lineIndex];
  const value = selectedValue.trim();
  if (!value || value.length > MAX_VALUE) throw new HttpError(422, "Select between 1 and 500 characters.");
  const matches = occurrences(line, value);
  if (matches.length !== 1) throw new HttpError(422, "Refine the value so it appears exactly once in the selected line.");
  const at = matches[0];
  const beforeText = [lines[lineIndex - 1], line.slice(0, at)].filter(Boolean).join("\n");
  const afterText = [line.slice(at + value.length), lines[lineIndex + 1]].filter(Boolean).join("\n");
  const rule: SelectedTextRule = {
    version: 1,
    kind: "bounded_context",
    before: beforeText.slice(-MAX_ANCHOR),
    after: afterText.slice(0, MAX_ANCHOR),
    max_length: Math.min(MAX_VALUE, Math.max(value.length * 4, 64)),
  };
  if (!rule.before && !rule.after) throw new HttpError(422, "A stable rule cannot be generated without surrounding context.");
  const source = lines.join("\n");
  const extracted = applySelectedTextRule(source, rule);
  if (extracted !== value) throw new HttpError(422, "The selected value is not uniquely anchored. Refine the selection.");
  const shorten = (input: string, fromEnd = false) => {
    const compact = input.replace(/\s+/g, " ");
    return fromEnd ? compact.slice(-48) : compact.slice(0, 48);
  };
  return { rule, extracted, description: `Text between “${shorten(rule.before, true)}” and “${shorten(rule.after)}”` };
}
