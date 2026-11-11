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
export type SelectedTextRuleV3 = {
  version: 3;
  kind: "contextual_segments";
  anchors: { shape: string; offset: number }[];
  prefix: string;
  suffix: string;
  max_length: number;
  cohort?: { shape: string; count: number };
};
export type SelectedTextRule = SelectedTextRuleV1 | SelectedTextRuleV2 | SelectedTextRuleV3;

const MAX_ANCHOR = 160;
const MAX_VALUE = 500;
export const MAX_READER_CONTENT = 200_000;
export const MAX_READER_RESULTS = 100;
const MAX_SEGMENT = 800;
const MAX_SEGMENTS = 4096;

// Segments are views of the original provider/browser text. The source text is
// never modified or interpreted as HTML; start/end retain the exact span used
// by both the picker and V3 capture rules.
export function segmentSelectedText(text: string) {
  if (text.length > MAX_READER_CONTENT) throw new HttpError(422, "Text content is too large to preview safely.");
  const segments: { text: string; start: number; end: number }[] = [];
  const push = (start: number, end: number) => {
    while (start < end) {
      let stop = Math.min(end, start + MAX_SEGMENT);
      if (stop < end) {
        const window = text.slice(start, stop);
        const safe = [...window.matchAll(/[\s;,{}](?=\S)/g)].map(match => match.index + 1)
          .filter(index => index >= MAX_SEGMENT / 3 && !(/[\p{N}]/u.test(window[index - 2] ?? "") && /[\p{N}]/u.test(window[index] ?? "")) && !/[₺$€£]/u.test(window[index] ?? ""))
          .pop();
        if (safe) stop = start + safe;
        else if (/^https?:\/\/\S+$/i.test(text.slice(start, Math.min(end, start + 2048))) && end - start <= 2048) stop = end;
      }
      if (stop < end && stop > start && /[\uD800-\uDBFF]/.test(text[stop - 1]) && /[\uDC00-\uDFFF]/.test(text[stop])) stop--;
      const raw = text.slice(start, stop);
      const left = raw.length - raw.trimStart().length;
      const right = raw.length - raw.trimEnd().length;
      if (raw.trim()) segments.push({ text: raw.slice(left, raw.length - right), start: start + left, end: stop - right });
      if (segments.length > MAX_SEGMENTS) throw new HttpError(422, "Text has too many fragments to preview safely.");
      start = stop;
    }
  };
  let start = 0;
  const boundaries = /\n+|<\/(?:p|li|h[1-6]|div)\s*>|<br\s*\/?>|[.!?]\s+|[;{}](?=\S)/giu;
  for (const match of text.matchAll(boundaries)) {
    const end = match.index + match[0].length;
    const minimum = /^[;{}]/.test(match[0]) ? 100 : 24;
    if (end - start < minimum && !match[0].includes("\n")) continue;
    push(start, end);
    start = end;
  }
  push(start, text.length);
  return segments;
}

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
  if (matches.length > 1) throw new HttpError(422, "Selected text is ambiguous in the current text.");
  throw new HttpError(422, "Selected text could not be found in the current text.");
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
  if (rule.kind !== "anchored_lines" || rule.max_length < 1 || rule.max_length > MAX_VALUE || typeof rule.prefix !== "string" || rule.prefix.length > MAX_ANCHOR || typeof rule.suffix !== "string" || rule.suffix.length > MAX_ANCHOR || !Array.isArray(rule.anchors) || rule.anchors.length < 2 || rule.anchors.length > 4)
    throw new HttpError(422, "Selected text rule is invalid.");
  const lines = readableJinaLines(text);
  const evidence = new Map<number, number>();
  let ambiguousAnchor = false;
  for (const anchor of rule.anchors) {
    if (!anchor || typeof anchor.text !== "string" || !anchor.text || anchor.text.length > MAX_ANCHOR || !Number.isInteger(anchor.offset) || !anchor.offset || Math.abs(anchor.offset) > 2)
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
  throw new HttpError(422, candidates.length || ambiguousAnchor ? "Selected text is ambiguous in the current text." : "Selected text could not be found in the current text.");
}

export function applySelectedTextRule(text: string, rule: SelectedTextRule) {
  if (rule.version === 1) return applyV1(text, rule);
  if (rule.version === 2) return applyV2(text, rule);
  if (rule.version === 3) return resolveV3(text, rule).value;
  throw new HttpError(422, "Selected text rule is invalid.");
}

export function generateLegacySelectedTextRule(lines: string[], lineIndex: number, selectedValue: string) {
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
    // Keep the context closest to the changing value. This preserves exact
    // extraction semantics while guaranteeing that generated rules satisfy the
    // API and editor's bounded schema even when Reader lines are very long.
    prefix: line.slice(Math.max(0, at - MAX_ANCHOR), at),
    suffix: line.slice(at + value.length, at + value.length + MAX_ANCHOR),
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

function segmentShape(text: string) {
  // A nearby amount can change without invalidating its contextual role.
  return text.replace(/\p{N}(?:[\p{N}.,]*\p{N})?/gu, "#");
}

function validateV3(rule: SelectedTextRuleV3) {
  if (rule.kind !== "contextual_segments" || typeof rule.prefix !== "string" || rule.prefix.length > MAX_ANCHOR ||
      typeof rule.suffix !== "string" || rule.suffix.length > MAX_ANCHOR || !Number.isInteger(rule.max_length) ||
      rule.max_length < 1 || rule.max_length > MAX_VALUE || !Array.isArray(rule.anchors) || rule.anchors.length > 3 ||
      (rule.cohort !== undefined && (!rule.cohort || typeof rule.cohort.shape !== "string" || !rule.cohort.shape || rule.cohort.shape.length > MAX_ANCHOR || !Number.isInteger(rule.cohort.count) || rule.cohort.count < 1 || rule.cohort.count > MAX_SEGMENTS)) ||
      rule.anchors.some(anchor => !anchor || typeof anchor.shape !== "string" || !anchor.shape || anchor.shape.length > MAX_ANCHOR ||
        !Number.isInteger(anchor.offset) || anchor.offset === 0 || Math.abs(anchor.offset) > 12))
    throw new HttpError(422, "Selected text rule is invalid.");
}

function valueFromSegment(segment: string, rule: SelectedTextRuleV3) {
  const starts = rule.prefix ? occurrences(segment, rule.prefix).map(index => index + rule.prefix.length) : [0];
  const values: string[] = [];
  for (const start of starts) {
    const end = rule.suffix ? segment.indexOf(rule.suffix, start) : segment.length;
    if (end < start || end - start > rule.max_length) continue;
    const value = segment.slice(start, end).trim();
    if (value) values.push(value);
  }
  return values.length === 1 ? values[0] : undefined;
}

function resolveV3(text: string, rule: SelectedTextRuleV3) {
  validateV3(rule);
  const lines = segmentSelectedText(text).map(segment => segment.text);
  let candidates = lines.map((line, index) => ({ index, value: valueFromSegment(line, rule) })).filter((item): item is { index: number; value: string } => !!item.value);
  if (rule.cohort) {
    const sameShape = lines.filter(line => segmentShape(line) === rule.cohort!.shape).length;
    if (sameShape !== rule.cohort.count) throw new HttpError(422, "Selected text context changed. Refresh the preview and confirm the target again.");
    candidates = candidates.filter(item => segmentShape(lines[item.index]) === rule.cohort!.shape);
  }
  for (const anchor of rule.anchors) {
    const found: number[] = [];
    for (let index = 0; index < lines.length; index++) if (segmentShape(lines[index]) === anchor.shape) found.push(index);
    if (found.length !== 1) throw new HttpError(422, found.length > 1 ? "Selected text is ambiguous in the current text. Refresh and choose more specific context." : "Selected text context is missing. Refresh the preview and select it again.");
    const target = found[0] - anchor.offset;
    candidates = candidates.filter(item => item.index === target);
  }
  if (candidates.length === 1) return candidates[0];
  throw new HttpError(422, candidates.length ? "Selected text is ambiguous in the current text. Refresh and choose more specific context." : "Selected text could not be found in the current text. Refresh the preview and select it again.");
}

export function generateSelectedTextRule(lines: string[], lineIndex: number, selectedValue: string) {
  if (!Number.isInteger(lineIndex) || lineIndex < 0 || lineIndex >= lines.length) throw new HttpError(422, "Select a valid preview segment.");
  const line = lines[lineIndex];
  const value = selectedValue.trim();
  if (!value || value.length > MAX_VALUE) throw new HttpError(422, "Select between 1 and 500 characters.");
  const matches = occurrences(line, value);
  if (matches.length !== 1) throw new HttpError(422, "This value occurs more than once in the selected segment. Choose a smaller segment or include unique surrounding text.");
  const at = matches[0];
  const rule: SelectedTextRuleV3 = {
    version: 3,
    kind: "contextual_segments",
    anchors: [],
    prefix: line.slice(Math.max(0, at - MAX_ANCHOR), at),
    suffix: line.slice(at + value.length, at + value.length + MAX_ANCHOR),
    max_length: Math.min(MAX_VALUE, Math.max(value.length * 4, 64)),
  };
  const source = lines.join("\n");
  const matchesTarget = () => {
    try { const result = resolveV3(source, rule); return result.index === lineIndex && result.value === value; }
    catch { return false; }
  };
  if (!matchesTarget()) {
    const shapes = lines.map(segmentShape);
    const counts = new Map<string, number>();
    for (const shape of shapes) counts.set(shape, (counts.get(shape) ?? 0) + 1);
    const targetShape = shapes[lineIndex];
    if (!rule.prefix && !rule.suffix && targetShape.length <= MAX_ANCHOR)
      rule.cohort = { shape: targetShape, count: counts.get(targetShape)! };
    const nearby = shapes.map((shape, index) => ({ shape, offset: index - lineIndex }))
      .filter(anchor => anchor.offset && Math.abs(anchor.offset) <= 12 && anchor.shape.length <= MAX_ANCHOR &&
        counts.get(anchor.shape) === 1)
      .sort((a, b) => Math.abs(a.offset) - Math.abs(b.offset));
    for (const anchor of nearby.slice(0, 3)) {
      rule.anchors.push(anchor);
      if (matchesTarget()) break;
    }
  }
  if (!matchesTarget()) throw new HttpError(422, "The selected occurrence cannot be distinguished safely. Select a value with unique nearby context.");
  return { rule, extracted: value, description: rule.anchors.length ? "Value anchored by nearby text and position" : "Value identified by its surrounding text" };
}
