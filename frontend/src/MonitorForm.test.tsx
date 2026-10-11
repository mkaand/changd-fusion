import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Form } from "antd";
import { it, expect, afterEach } from "vitest";
import { MonitorForm } from "./MonitorForm";
let current: ReturnType<typeof Form.useForm>[0];
function Fixture() {
  const [form] = Form.useForm();
  current = form;
  return <MonitorForm form={form} channels={[]} />;
}
afterEach(cleanup);
it("text and visual settings share one form with independent region and text selectors", async () => {
  const user = userEvent.setup();
  render(<Fixture />);
  await user.click(screen.getByRole("switch", { name: "Visual detection" }));
  expect(
    screen.getByRole("switch", { name: "Text detection" }),
  ).toHaveAttribute("aria-checked", "true");
  await user.click(screen.getByText("Advanced settings", { exact: true }));
  await user.click(screen.getByLabelText("Screenshot capture mode"));
  await user.click(screen.getByText("Selected element / region"));
  await user.type(
    screen.getByLabelText("Screenshot region selector"),
    "#region",
  );
  expect(current.getFieldValue("capture_mode")).toBe("element");
  expect(current.getFieldValue("capture_selector")).toBe("#region");
  expect(current.getFieldValue("visual_threshold")).toBe("0.35");
  expect(
    screen.getByLabelText("Text selector (empty = visible page text)"),
  ).toBeInTheDocument();
});
it("HTML/API selection returns to text-only viewport configuration", async () => {
  const user = userEvent.setup();
  render(<Fixture />);
  await user.click(screen.getByRole("switch", { name: "Visual detection" }));
  await user.click(screen.getByText("Advanced settings", { exact: true }));
  await user.click(screen.getByLabelText("Source"));
  await user.click(screen.getByText("API / JSON"));
  await waitFor(() =>
    expect(current.getFieldValue("visual_enabled")).toBe(false),
  );
  expect(current.getFieldValue("text_enabled")).toBe(true);
  expect(current.getFieldValue("capture_mode")).toBe("viewport");
  expect(
    screen.getByRole("switch", { name: "Visual detection" }),
  ).toBeDisabled();
});
