import { useSyncExternalStore } from "react";
import { theme, type ThemeConfig } from "antd";

export type ThemePreference = "light" | "dark" | "system";
export type ThemeAdapter = {
  preference: ThemePreference;
  resolved: "light" | "dark";
  setPreference: (value: ThemePreference) => void;
};

export const ALLMY_THEME_KEY = "allmy-theme";
const legacyKey = "fusion_theme_preference";
const listeners = new Set<() => void>();
const media =
  typeof window === "undefined"
    ? undefined
    : window.matchMedia("(prefers-color-scheme: dark)");

function safeStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function normalize(value: string | null): ThemePreference | undefined {
  return value === "light" || value === "dark" || value === "system"
    ? value
    : undefined;
}

function readPreference(): ThemePreference {
  const storage = safeStorage();
  if (!storage) return "system";
  try {
    const stored = storage.getItem(ALLMY_THEME_KEY);
    const mode = normalize(stored);
    if (mode) return mode;
    if (stored !== null) storage.removeItem(ALLMY_THEME_KEY);
    const legacy = storage.getItem(legacyKey);
    const legacyMode = normalize(legacy);
    if (legacyMode) {
      if (legacyMode === "system") storage.removeItem(ALLMY_THEME_KEY);
      else storage.setItem(ALLMY_THEME_KEY, legacyMode);
      storage.removeItem(legacyKey);
      return legacyMode;
    }
    if (legacy !== null) storage.removeItem(legacyKey);
  } catch {
    return "system";
  }
  return "system";
}

let preference = readPreference();
const resolve = (mode = preference): "light" | "dark" =>
  mode === "system" ? (media?.matches ? "dark" : "light") : mode;

export function applyTheme(mode = preference) {
  const resolved = resolve(mode);
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themeMode = mode;
    document.documentElement.style.colorScheme = resolved;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (meta) meta.content = resolved === "dark" ? "#0b1220" : "#f5f6f1";
  }
  return resolved;
}

const notify = () => listeners.forEach((listener) => listener());
export function setThemePreference(value: ThemePreference) {
  if (!normalize(value)) throw Error("Invalid theme preference");
  preference = value;
  const storage = safeStorage();
  try {
    if (value === "system") storage?.removeItem(ALLMY_THEME_KEY);
    else storage?.setItem(ALLMY_THEME_KEY, value);
    storage?.removeItem(legacyKey);
  } catch {
    /* Storage is optional; the active tab still receives the preference. */
  }
  applyTheme();
  notify();
}

media?.addEventListener?.("change", () => {
  if (preference === "system") {
    applyTheme();
    notify();
  }
});
if (typeof window !== "undefined")
  window.addEventListener("storage", (event) => {
    if (event.key !== ALLMY_THEME_KEY) return;
    const mode = normalize(event.newValue);
    preference = mode ?? "system";
    if (!mode && event.newValue !== null) {
      try {
        safeStorage()?.removeItem(ALLMY_THEME_KEY);
      } catch {}
    }
    applyTheme();
    notify();
  });

applyTheme();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => `${preference}:${resolve()}`;

export function useThemeAdapter(): ThemeAdapter {
  const state = useSyncExternalStore(subscribe, snapshot, () => "system:light");
  const [saved, resolvedTheme] = state.split(":");
  return {
    preference: saved as ThemePreference,
    resolved: resolvedTheme as "light" | "dark",
    setPreference: setThemePreference,
  };
}

export const fusionTheme: ThemeConfig = {
  token: {
    colorPrimary: "#1677ff",
    borderRadius: 6,
    fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
};
export const themeConfig = (resolved: "light" | "dark"): ThemeConfig => ({
  ...fusionTheme,
  algorithm: resolved === "dark" ? theme.darkAlgorithm : theme.defaultAlgorithm,
});
