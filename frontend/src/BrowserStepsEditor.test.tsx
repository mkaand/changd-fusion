import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Form } from "antd";
import { it, expect, afterEach } from "vitest";
import { BrowserStepsEditor } from "./BrowserStepsEditor";
let form: any;
function Fixture() {
  const [f] = Form.useForm();
  form = f;
  return (
    <Form form={f} initialValues={{ browser_steps: [], step_budget_ms: 20000 }}>
      <BrowserStepsEditor form={f} />
    </Form>
  );
}
afterEach(cleanup);
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
