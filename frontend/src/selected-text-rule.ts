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
  anchors: { text: string; offset: -2 | -1 | 1 | 2 }[];
  prefix: string;
  suffix: string;
  max_length: number;
};

export type SelectedTextRule = SelectedTextRuleV1 | SelectedTextRuleV2;

export function isValidSelectedTextRule(value: unknown): value is SelectedTextRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rule = value as Record<string, unknown>;
  if (rule.version === 1 && rule.kind === "bounded_context")
    return Object.keys(rule).length === 5 && ["version", "kind", "before", "after", "max_length"].every((key) => key in rule) &&
      typeof rule.before === "string" && rule.before.length <= 160 &&
      typeof rule.after === "string" && rule.after.length <= 160 &&
      Number.isInteger(rule.max_length) && (rule.max_length as number) >= 1 &&
      (rule.max_length as number) <= 500 && !!(rule.before || rule.after);
  if (rule.version !== 2 || rule.kind !== "anchored_lines" || Object.keys(rule).length !== 6 || !["version", "kind", "anchors", "prefix", "suffix", "max_length"].every((key) => key in rule)) return false;
  return Array.isArray(rule.anchors) && rule.anchors.length >= 2 && rule.anchors.length <= 4 &&
    rule.anchors.every((anchor) => !!anchor && typeof anchor === "object" && !Array.isArray(anchor) && Object.keys(anchor).length === 2 &&
      typeof (anchor as Record<string, unknown>).text === "string" && !!(anchor as Record<string, unknown>).text && ((anchor as Record<string, unknown>).text as string).length <= 160 &&
      [-2, -1, 1, 2].includes((anchor as Record<string, unknown>).offset as number)) &&
    typeof rule.prefix === "string" && rule.prefix.length <= 160 &&
    typeof rule.suffix === "string" && rule.suffix.length <= 160 &&
    Number.isInteger(rule.max_length) && (rule.max_length as number) >= 1 && (rule.max_length as number) <= 500;
}
