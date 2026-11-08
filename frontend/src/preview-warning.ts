export function describePreviewWarning(code: string) {
  if (code === "browser_steps_skipped_http_error") return "Browser steps were skipped because the initial response was an HTTP error page.";
  const optional = /^optional_step_failed:(\d+):([^:]+):([^:]+)$/.exec(code);
  if (optional) {
    const [, index, action, reason] = optional;
    const actionLabel = action === "dismiss_cookie" ? "dismiss the cookie banner" : `run “${action.replaceAll("_", " ")}"`;
    const reasonLabel = reason === "selector_missing" ? "its selector was not found" : reason.replaceAll("_", " ");
    return `Optional browser step ${Number(index) + 1} could not ${actionLabel} because ${reasonLabel}. The preview is still available.`;
  }
  return "A browser step reported a warning. The preview is still available.";
}
