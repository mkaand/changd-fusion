import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";
import { Login } from "./Login";
import { percent, loginUser } from "./api";
vi.mock("./api", async () => ({
  ...(await vi.importActual("./api")),
  loginUser: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe("Login", () => {
  it("submits actual form values and completes successful authentication", async () => {
    vi.mocked(loginUser).mockResolvedValue({ ok: true });
    const success = vi.fn(),
      user = userEvent.setup();
    render(<Login onSuccess={success} />);
    await user.type(screen.getByLabelText("Email"), "fixture@example.com");
    await user.type(
      screen.getByLabelText("Password"),
      "synthetic-fixture-password",
    );
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(loginUser).toHaveBeenCalledWith({
        email: "fixture@example.com",
        password: "synthetic-fixture-password",
      }),
    );
    await waitFor(() => expect(success).toHaveBeenCalledOnce());
  });
  it("displays authentication errors and never reports success", async () => {
    vi.mocked(loginUser).mockRejectedValue(Error("Invalid email or password"));
    const success = vi.fn(),
      user = userEvent.setup();
    render(<Login onSuccess={success} />);
    await user.type(screen.getByLabelText("Email"), "fixture@example.com");
    await user.type(
      screen.getByLabelText("Password"),
      "synthetic-fixture-password",
    );
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Invalid email or password",
    );
    expect(success).not.toHaveBeenCalled();
  });
  it("preserves decimal display including zero and 100 percent", () => {
    expect(percent("0.3500000000")).toBe("0.35%");
    expect(percent("0.0000000000")).toBe("0.00%");
    expect(percent("100.0000000000")).toBe("100.00%");
  });
});
