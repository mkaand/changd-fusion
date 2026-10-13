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
