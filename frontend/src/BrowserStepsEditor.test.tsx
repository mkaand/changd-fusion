import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Form } from "antd";
import { it, expect, afterEach, vi } from "vitest";
import { BrowserStepsEditor } from "./BrowserStepsEditor";
import { api } from "./api";
vi.mock("./api", async () => ({ ...(await vi.importActual<typeof import("./api")>("./api")), api: vi.fn() }));
let form: any;
function Fixture() {
  const [f] = Form.useForm();
  form = f;
  return (
    <Form form={f} initialValues={{ url: "https://fixture.example", kind: "browser", visual_enabled: false, browser_steps: [], step_budget_ms: 20000 }}>
      <BrowserStepsEditor form={f} />
    </Form>
  );
}
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("manual steps remain editable and saveable while Preview is pending", async () => {
  let signal: AbortSignal | undefined;
  vi.mocked(api).mockImplementation((_path, _method, _body, options) => {
    signal = options?.signal;
    return new Promise(() => {});
  });
  const user = userEvent.setup();
  render(<Fixture />);
  await user.click(screen.getByRole("button", { name: "Add step from Preview" }));
  await user.click(screen.getByRole("button", { name: "Add browser step" }));
  await user.type(screen.getByLabelText("Selector"), "#manual-target");
  const values = await form.validateFields();
  expect(values.browser_steps[0].selector).toBe("#manual-target");
  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(signal?.aborted).toBe(true);
  expect(form.getFieldValue("browser_steps")).toHaveLength(1);
});
it("accepts a 60-second step while preserving the independent workflow limit", async () => {
  render(<Fixture />);
  await userEvent.click(screen.getByRole("button", { name: "Add browser step" }));
  const timeout = screen.getByLabelText("Step timeout (ms)");
  expect(timeout).toHaveAttribute("aria-valuemin", "100");
  expect(timeout).toHaveAttribute("aria-valuemax", "60000");
  expect(screen.getByLabelText("Workflow budget (ms)")).toHaveAttribute("aria-valuemax", "60000");
});
it("browser steps can be added, reordered with keyboard-accessible buttons and removed", async () => {
  const user = userEvent.setup();
  render(<Fixture />);
  await user.click(screen.getByRole("button", { name: "Add browser step" }));
  await user.type(screen.getByLabelText("Selector"), "#first");
  await user.click(screen.getByRole("button", { name: "Add browser step" }));
  await user.type(screen.getAllByLabelText("Selector")[1], "#second");
  await user.click(screen.getByRole("button", { name: "Move step 2 up" }));
  expect(
    form.getFieldValue("browser_steps").map((s: any) => s.selector),
  ).toEqual(["#second", "#first"]);
  await user.click(screen.getByRole("button", { name: "Remove step 1" }));
  expect(
    form.getFieldValue("browser_steps").map((s: any) => s.selector),
  ).toEqual(["#first"]);
  expect(screen.getByRole("button", { name: "Move step 1 up" })).toBeDisabled();
});
it("changing an action clears irrelevant values and explains private credential references", async () => {
  const user = userEvent.setup();
  render(<Fixture />);
  await user.click(screen.getByRole("button", { name: "Add browser step" }));
  await user.click(screen.getByRole("combobox", { name: "Step 1 action" }));
  await user.click(screen.getByText("fill private"));
  expect(
    await screen.findByText(/Private values require HTTPS/),
  ).toBeInTheDocument();
  await user.type(
    screen.getByLabelText("Private value reference"),
    "account_password",
  );
  expect(form.getFieldValue("browser_steps")[0].credential).toBe(
    "account_password",
  );
  expect(
    screen.getByRole("switch", { name: "Step 1 continue on error" }),
  ).toBeDisabled();
  await user.click(screen.getByRole("combobox", { name: "Step 1 action" }));
  await user.click(screen.getByText("delay"));
  expect(form.getFieldValue("browser_steps")[0]).not.toHaveProperty(
    "credential",
  );
  expect(screen.getByLabelText("Delay (ms)")).toBeInTheDocument();
});
it("step editor validates required selectors and prevents more than twenty steps", async () => {
  render(<Fixture />);
  act(() =>
    form.setFieldsValue({
      browser_steps: Array.from({ length: 20 }, () => ({
        action: "wait_visible",
        selector: "",
        selector_type: "css",
        timeout_ms: 5000,
        continue_on_error: false,
      })),
    }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Add browser step" }),
    ).toBeDisabled(),
  );
  await expect(form.validateFields()).rejects.toBeTruthy();
});
it("adds and replays visual Preview steps only in the unsaved form draft", async () => {
  vi.mocked(api).mockImplementation((path: string, method?: string) => {
    if (method === "DELETE") return Promise.resolve({}) as any;
    return Promise.resolve({ session_id: "00000000-0000-4000-8000-000000000010", image: "aGVsbG8=", width: 1280, height: 900, selection: { selector: "#consent-reject", x: 10, y: 10, width: 120, height: 44 } }) as any;
  });
  const user = userEvent.setup();
  render(<Fixture />);
  await user.click(screen.getByRole("button", { name: "Add step from Preview" }));
  await screen.findByText("Selected visible element");
  await user.click(screen.getByRole("combobox", { name: "Browser step action" }));
  await user.click(screen.getByText("dismiss cookie"));
  await user.click(screen.getByRole("switch", { name: "Optional browser step" }));
  await user.click(screen.getByRole("button", { name: "Add step to draft" }));
  expect(form.getFieldValue("browser_steps")).toEqual([{ action: "dismiss_cookie", selector: "#consent-reject", selector_type: "css", timeout_ms: 5000, continue_on_error: true }]);
  await user.click(screen.getByRole("button", { name: "Replay preview" }));
  await waitFor(() => expect(vi.mocked(api).mock.calls.filter(([path]) => path === "/region-preview")).toHaveLength(2));
  expect(form.getFieldValue("browser_steps")).toHaveLength(1);
});
