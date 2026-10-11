import { render, screen, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { it, expect, afterEach, vi } from "vitest";
import { filterMonitors, monitorState } from "./monitor-status";
import { useThemeAdapter, setThemePreference, themeConfig, ALLMY_THEME_KEY } from "./theme";
import { AllMyThemeControls } from "./AllMyThemeControls";
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
it("AllMy controls persist explicit themes, return to Auto and expose the original accessibility states", async () => {
  function Fixture() {
    const a = useThemeAdapter();
    return <><span>{a.preference}:{a.resolved}</span><AllMyThemeControls adapter={a} /></>;
  }
  const user = userEvent.setup();
  const meta = document.createElement("meta");
  meta.name = "theme-color";
  document.head.append(meta);
  render(<Fixture />);
  expect(screen.getByText("system:light")).toBeInTheDocument();
  const toggle = screen.getByRole("switch");
  expect(toggle).toHaveAttribute("aria-checked", "false");
  await user.click(toggle);
  expect(screen.getByText("dark:dark")).toBeInTheDocument();
  expect(localStorage.getItem(ALLMY_THEME_KEY)).toBe("dark");
  expect(toggle).toHaveAttribute("aria-checked", "true");
  expect(toggle).toHaveAttribute("aria-label", "Switch to light theme");
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(document.documentElement.dataset.themeMode).toBe("dark");
  expect(document.documentElement.style.colorScheme).toBe("dark");
  expect(meta.content).toBe("#0b1220");
  expect(themeConfig("dark").algorithm).not.toEqual(
    themeConfig("light").algorithm,
  );
  await user.click(screen.getByRole("button", { name: "Use automatic system theme" }));
  expect(screen.getByText("system:light")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Use automatic system theme" })).toHaveAttribute("aria-pressed", "true");
  expect(localStorage.getItem(ALLMY_THEME_KEY)).toBeNull();
  act(() =>
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: ALLMY_THEME_KEY,
        newValue: "light",
      }),
    ),
  );
  expect(screen.getByText("light:light")).toBeInTheDocument();
  document.head.removeChild(meta);
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
it("delivery history keeps existing rows visible while a manual refresh is pending", async () => {
  let resolveRefresh: ((value: unknown) => void) | undefined;
  vi.mocked(api)
    .mockResolvedValueOnce({
      items: [
        {
          id: "fixture",
          monitor_id: "monitor",
          monitor_name: "Synthetic monitor",
          channel_name: "Telegram fixture",
          status: "sent",
          attempts: 1,
        },
      ],
      total: 1,
    })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        }),
    );
  const user = userEvent.setup();
  const { container } = render(<Deliveries />);
  expect(await screen.findByText("Synthetic monitor")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Refresh deliveries" }));
  expect(screen.getByText("Synthetic monitor")).toBeInTheDocument();
  expect(container.querySelector(".delivery-table .ant-spin-spinning")).toBeNull();
  await act(async () =>
    resolveRefresh?.({
      items: [],
      total: 0,
    }),
  );
  expect(screen.queryByText("Synthetic monitor")).not.toBeInTheDocument();
});
it("delivery history reports errors with a retry control", async () => {
  vi.mocked(api).mockRejectedValue(Error("Delivery history unavailable"));
  render(<Deliveries />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Delivery history unavailable",
  );
  expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
});
