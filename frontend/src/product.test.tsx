import { render, screen, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { it, expect, afterEach, vi } from "vitest";
import { filterMonitors, monitorState } from "./monitor-status";
import { useThemeAdapter, setThemePreference, themeConfig } from "./theme";
import { Deliveries } from "./Deliveries";
import { api } from "./api";
vi.mock("./api", () => ({ api: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  setThemePreference("system");
});
it("dashboard search and status filters distinguish paused, disabled and attention monitors", () => {
  const monitors = [
    {
      name: "News",
      url: "https://example.com",
      enabled: true,
      monitor_state: "healthy",
    },
    {
      name: "Store",
      url: "https://example.com/store",
      enabled: true,
      paused: true,
    },
    { name: "Off", url: "https://example.com", enabled: false },
    {
      name: "Login",
      url: "https://example.com",
      enabled: true,
      monitor_state: "authentication_required",
    },
  ];
  expect(filterMonitors(monitors, "news")).toHaveLength(1);
  expect(filterMonitors(monitors, "", "paused")[0].name).toBe("Store");
  expect(monitorState(monitors[2])).toBe("disabled");
  expect(filterMonitors(monitors, "", "authentication_required")).toHaveLength(
    1,
  );
});
it("theme adapter persists preferences, selects Ant Design algorithms and synchronizes storage changes without a replacement switch", () => {
  function Fixture() {
    const a = useThemeAdapter();
    return (
      <span>
        {a.preference}:{a.resolved}
      </span>
    );
  }
  render(<Fixture />);
  expect(screen.getByText("system:light")).toBeInTheDocument();
  act(() => setThemePreference("dark"));
  expect(screen.getByText("dark:dark")).toBeInTheDocument();
  expect(localStorage.getItem("fusion_theme_preference")).toBe("dark");
  expect(themeConfig("dark").algorithm).not.toEqual(
    themeConfig("light").algorithm,
  );
  act(() =>
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "fusion_theme_preference",
        newValue: "light",
      }),
    ),
  );
  expect(screen.getByText("light:light")).toBeInTheDocument();
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
});
it("notification delivery history displays retries and authorized administrative retry", async () => {
  vi.mocked(api).mockResolvedValue({
    items: [
      {
        id: "fixture",
        monitor_id: "monitor",
        monitor_name: "Synthetic monitor",
        channel_name: "SMTP fixture",
        status: "failed",
        attempts: 5,
        last_error: "Provider delivery failed",
      },
    ],
    total: 1,
  });
  const user = userEvent.setup();
  render(<Deliveries admin />);
  expect(await screen.findByText("Synthetic monitor")).toBeInTheDocument();
  expect(screen.getByText("failed")).toBeInTheDocument();
  await user.click(screen.getByText("Retry delivery"));
  expect(api).toHaveBeenCalledWith("/deliveries/fixture/retry", "POST", {});
});
it("delivery history reports errors with a retry control", async () => {
  vi.mocked(api).mockRejectedValue(Error("Delivery history unavailable"));
  render(<Deliveries />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Delivery history unavailable",
  );
  expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
});
