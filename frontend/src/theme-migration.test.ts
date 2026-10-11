import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  localStorage.clear();
  vi.resetModules();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-theme-mode");
});

it("migrates legacy values once, clears invalid values and follows system changes only in Auto", async () => {
  const listeners: Array<() => void> = [];
  const media = {
    matches: false,
    addEventListener: (_: string, listener: () => void) => listeners.push(listener),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal("matchMedia", vi.fn(() => media));
  localStorage.setItem("fusion_theme_preference", "dark");
  const first = await import("./theme");
  expect(localStorage.getItem("allmy-theme")).toBe("dark");
  expect(localStorage.getItem("fusion_theme_preference")).toBeNull();
  expect(document.documentElement.dataset.theme).toBe("dark");
  first.setThemePreference("system");
  expect(localStorage.getItem("allmy-theme")).toBeNull();
  media.matches = true;
  listeners.forEach((listener) => listener());
  expect(document.documentElement.dataset.theme).toBe("dark");
  first.setThemePreference("light");
  media.matches = false;
  listeners.forEach((listener) => listener());
  expect(document.documentElement.dataset.theme).toBe("light");
  localStorage.setItem("allmy-theme", "invalid");
  window.dispatchEvent(new StorageEvent("storage", { key: "allmy-theme", newValue: "invalid" }));
  expect(localStorage.getItem("allmy-theme")).toBeNull();
  expect(document.documentElement.dataset.themeMode).toBe("system");
});
