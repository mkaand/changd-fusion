import type { ThemeAdapter } from "./theme";

export function AllMyThemeControls({ adapter }: { adapter: ThemeAdapter }) {
  const isDark = adapter.resolved === "dark";
  const nextTheme = isDark ? "light" : "dark";
  return (
    <div className="allmy-theme-controls" role="group" aria-label="Theme controls" data-allmy-theme-controls="">
      <button className="allmy-theme-switch" type="button" role="switch" aria-checked={isDark} aria-label={`Switch to ${nextTheme} theme`} title={`Switch to ${nextTheme} theme`} data-allmy-theme-switch="" onClick={() => adapter.setPreference(nextTheme)}>
        <span className="allmy-theme-switch__sun" aria-hidden="true">☀</span>
        <span className="allmy-theme-switch__track" aria-hidden="true"><span className="allmy-theme-switch__thumb" /></span>
        <span className="allmy-theme-switch__moon" aria-hidden="true">☾</span>
      </button>
      <button className="allmy-theme-auto" type="button" aria-pressed={adapter.preference === "system"} aria-label="Use automatic system theme" title="Use automatic system theme" data-allmy-theme-auto="" onClick={() => adapter.setPreference("system")}>
        <span aria-hidden="true">A</span>
        <span className="allmy-theme-controls__sr-only">Automatic</span>
      </button>
    </div>
  );
}
