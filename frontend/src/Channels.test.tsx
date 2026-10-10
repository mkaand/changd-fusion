import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { it, expect, afterEach, vi } from "vitest";
import { Channels } from "./Channels";
import { api } from "./api";
vi.mock("./api", () => ({ api: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const channel = {
  id: "fixture",
  name: "Telegram fixture",
  provider: "telegram",
  enabled: true,
  config: { chat_id: "-123456", timezone: "Europe/Istanbul" },
};
it("Telegram editor preserves an existing timezone and never prepopulates the write-only token", async () => {
  const user = userEvent.setup();
  render(
    <Channels
      channels={[channel]}
      monitors={[{ id: "monitor" }]}
      reload={vi.fn()}
      report={vi.fn()}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Edit" }));
  expect(screen.getByLabelText("Bot token")).toHaveValue("");
  expect(screen.getByText("Europe/Istanbul")).toBeInTheDocument();
  expect(
    screen.getByText(/Telegram messages are in English/),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "OK" }));
  expect(api).toHaveBeenCalledWith(
    "/notifications/fixture",
    "PUT",
    expect.objectContaining({
      config: expect.objectContaining({
        chat_id: "-123456",
        timezone: "Europe/Istanbul",
      }),
    }),
  );
});
it("validates a Telegram bot only after explicit user action", async () => {
  vi.mocked(api).mockResolvedValue({ valid: true, bot: { first_name: "Fixture", username: "fixture_bot" } });
  const user = userEvent.setup(), report = vi.fn();
  render(<Channels channels={[channel]} monitors={[]} reload={vi.fn()} report={report} />);
  expect(api).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Validate Bot" }));
  expect(api).toHaveBeenCalledWith("/notifications/fixture/validate", "POST", {});
  expect(report).toHaveBeenCalledWith("Bot validated: Fixture (@fixture_bot)");
});
it("Telegram sends nothing on mount and requires an explicit monitor selection", async () => {
  vi.mocked(api).mockResolvedValue({ queued: true });
  const user = userEvent.setup();
  const report = vi.fn();
  render(
    <Channels
      channels={[channel]}
      monitors={[{ id: "monitor" }]}
      reload={vi.fn()}
      report={report}
    />,
  );
  expect(api).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Test notification" })).toBeDisabled();
  expect(screen.getByLabelText("Test notification monitor")).toBeInTheDocument();
});
