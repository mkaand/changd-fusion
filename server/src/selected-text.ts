import { HttpError } from "./errors.js";

export type SelectedTextRuleV1 = {
  version: 1;
  kind: "bounded_context";
  before: string;
  after: string;
  max_length: number;
};
export type SelectedTextRuleV2 = {
  version: 2;
  kind: "anchored_lines";
  anchors: { text: string; offset: number }[];
  prefix: string;
  suffix: string;
  max_length: number;
};
export type SelectedTextRule = SelectedTextRuleV1 | SelectedTextRuleV2;

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

function validateV1(rule: SelectedTextRuleV1) {
  if (rule.kind !== "bounded_context" || rule.max_length < 1 || rule.max_length > MAX_VALUE)
    throw new HttpError(422, "Selected text rule is invalid.");
  if (!rule.before && !rule.after) throw new HttpError(422, "Selected text rule has no stable context.");
}

function applyV1(text: string, rule: SelectedTextRuleV1) {
  validateV1(rule);
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
  throw new HttpError(422, "Selected text could not be found in the current Reader output.");
}

function selectedValueFromLine(line: string, rule: SelectedTextRuleV2) {
  const starts = rule.prefix ? occurrences(line, rule.prefix).map((index) => index + rule.prefix.length) : [0];
  const values: string[] = [];
  for (const start of starts) {
    const end = rule.suffix ? line.indexOf(rule.suffix, start) : line.length;
    if (end < start || end - start > rule.max_length) continue;
    const value = line.slice(start, end).trim();
    if (value) values.push(value);
  }
  return values.length === 1 ? values[0] : undefined;
}

function applyV2(text: string, rule: SelectedTextRuleV2) {
  if (rule.kind !== "anchored_lines" || rule.max_length < 1 || rule.max_length > MAX_VALUE || !Array.isArray(rule.anchors) || rule.anchors.length < 2 || rule.anchors.length > 4)
    throw new HttpError(422, "Selected text rule is invalid.");
  const lines = readableJinaLines(text);
  const evidence = new Map<number, number>();
  let ambiguousAnchor = false;
  for (const anchor of rule.anchors) {
    if (!anchor || typeof anchor.text !== "string" || !anchor.text || !Number.isInteger(anchor.offset) || !anchor.offset || Math.abs(anchor.offset) > 2)
      throw new HttpError(422, "Selected text rule is invalid.");
    let found = -1;
    for (let index = 0; index < lines.length; index++) {
      if (lines[index] !== anchor.text) continue;
      if (found !== -1) { found = -2; ambiguousAnchor = true; break; }
      found = index;
    }
    if (found < 0) continue;
    const target = found - anchor.offset;
    if (target >= 0 && target < lines.length) evidence.set(target, (evidence.get(target) ?? 0) + 1);
  }
  const candidates = [...evidence].filter(([, proof]) => proof >= 2).map(([index]) => selectedValueFromLine(lines[index], rule)).filter((value): value is string => !!value);
  if (!ambiguousAnchor && candidates.length === 1) return candidates[0];
  throw new HttpError(422, candidates.length || ambiguousAnchor ? "Selected text is ambiguous in the current Reader output." : "Selected text could not be found in the current Reader output.");
}

export function applySelectedTextRule(text: string, rule: SelectedTextRule) {
  if (rule.version === 1) return applyV1(text, rule);
  if (rule.version === 2) return applyV2(text, rule);
  throw new HttpError(422, "Selected text rule is invalid.");
}

export function generateSelectedTextRule(lines: string[], lineIndex: number, selectedValue: string) {
  if (!Number.isInteger(lineIndex) || lineIndex < 0 || lineIndex >= lines.length) throw new HttpError(422, "Select a valid preview line.");
  const line = lines[lineIndex];
  const value = selectedValue.trim();
  if (!value || value.length > MAX_VALUE) throw new HttpError(422, "Select between 1 and 500 characters.");
  const matches = occurrences(line, value);
  if (matches.length !== 1) throw new HttpError(422, "Refine the value so it appears exactly once in the selected line.");
  const at = matches[0];
  const anchors = [-2, -1, 1, 2]
    .map((offset) => ({ text: lines[lineIndex + offset], offset }))
    .filter((anchor): anchor is { text: string; offset: number } => !!anchor.text && anchor.text.length <= MAX_ANCHOR);
  if (anchors.length < 2) throw new HttpError(422, "A stable rule cannot be generated without at least two surrounding lines.");
  const rule: SelectedTextRuleV2 = {
    version: 2,
    kind: "anchored_lines",
    anchors,
    prefix: line.slice(0, at),
    suffix: line.slice(at + value.length),
    max_length: Math.min(MAX_VALUE, Math.max(value.length * 4, 64)),
  };
  const source = lines.join("\n");
  const extracted = applySelectedTextRule(source, rule);
  if (extracted !== value) throw new HttpError(422, "The selected value is not uniquely anchored. Refine the selection.");
  const shorten = (input: string, fromEnd = false) => {
    const compact = input.replace(/\s+/g, " ");
    return fromEnd ? compact.slice(-48) : compact.slice(0, 48);
  };
  return { rule, extracted, description: `Text anchored by “${shorten(anchors.map((anchor) => anchor.text).join(" · "), true)}”` };
}
