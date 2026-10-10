import { useSyncExternalStore } from "react";
import { theme, type ThemeConfig } from "antd";
export type ThemePreference = "light" | "dark" | "system";
export type ThemeAdapter = {
  preference: ThemePreference;
  resolved: "light" | "dark";
  setPreference: (value: ThemePreference) => void;
};
const key = "fusion_theme_preference";
const listeners = new Set<() => void>();
let preference: ThemePreference = "system";
try {
  const saved = localStorage.getItem(key);
  if (saved === "light" || saved === "dark" || saved === "system")
    preference = saved;
} catch {
  /* Storage can be unavailable; system remains the default. */
}
const media =
  typeof window !== "undefined"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : undefined;
const notify = () => listeners.forEach((fn) => fn());
media?.addEventListener?.("change", notify);
if (typeof window !== "undefined")
  window.addEventListener("storage", (e) => {
    if (e.key === key) {
      preference =
        e.newValue === "light" || e.newValue === "dark" ? e.newValue : "system";
      notify();
    }
  });
export function setThemePreference(value: ThemePreference) {
  if (!["light", "dark", "system"].includes(value))
    throw Error("Invalid theme preference");
  preference = value;
  try {
    localStorage.setItem(key, value);
  } catch {}
  notify();
}
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
const snapshot = () =>
  `${preference}:${preference === "system" ? (media?.matches ? "dark" : "light") : preference}`;
export function useThemeAdapter(): ThemeAdapter {
  const state = useSyncExternalStore(subscribe, snapshot, () => "system:light");
  const [saved, resolved] = state.split(":");
  return {
    preference: saved as ThemePreference,
    resolved: resolved as "light" | "dark",
    setPreference: setThemePreference,
  };
}
// Adapter only. The owner's exact shared-ui control has not been supplied and is not recreated here.
export const fusionTheme: ThemeConfig = {
  token: {
    colorPrimary: "#1677ff",
    borderRadius: 6,
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
  },
};
export const themeConfig = (resolved: "light" | "dark"): ThemeConfig => ({
  ...fusionTheme,
  algorithm: resolved === "dark" ? theme.darkAlgorithm : theme.defaultAlgorithm,
});
