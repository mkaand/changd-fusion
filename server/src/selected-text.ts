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

export function readableJinaLines(text: string) {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/[\t ]+/g, " ");
  if (normalized.length > 200_000) throw new HttpError(422, "Reader content is too large to preview safely.");
  return normalized.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 2000);
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
  if (matches.length !== 1) throw new HttpError(422, matches.length ? "Selected text is ambiguous in the current Reader output." : "Selected text could not be found in the current Reader output.");
  return matches[0];
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
