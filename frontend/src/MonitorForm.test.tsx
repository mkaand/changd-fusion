import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Form } from "antd";
import { it, expect, afterEach } from "vitest";
import { MonitorForm, isValidSelectedTextRule } from "./MonitorForm";
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
it("offers focused Jina extraction modes and hides incompatible browser controls", async () => {
  const user = userEvent.setup();
  render(<Fixture />);
  await user.click(screen.getByText("Advanced settings", { exact: true }));
  expect(screen.queryByLabelText("Extraction mode")).not.toBeInTheDocument();
  await user.click(screen.getByLabelText("Text content source"));
  await user.click(screen.getByText(/Jina Reader/));
  expect(screen.getByLabelText("Extraction mode")).toBeInTheDocument();
  await user.click(screen.getByLabelText("Extraction mode"));
  await user.click(screen.getByText("Product Price", { exact: true }));
  expect(current.getFieldValue("extraction_mode")).toBe("product_price");
  expect(screen.queryByLabelText("Text extraction method")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Add browser step" })).not.toBeInTheDocument();
  await user.click(screen.getByLabelText("Extraction mode"));
  await user.click(screen.getByText("Selected Text / Value", { exact: true }));
  expect(screen.getByRole("button", { name: "Select text from preview" })).toBeInTheDocument();
});

it.each([
  ["Full text (default)", "full_text"],
  ["Product Price", "product_price"],
  ["Selected Text / Value", "selected_text"],
])("submits Direct Browser with full text after switching from Jina %s", async (label, mode) => {
  const user = userEvent.setup();
  render(<Fixture />);
  await user.click(screen.getByText("Advanced settings", { exact: true }));
  await user.click(screen.getByLabelText("Text content source"));
  await user.click(screen.getByText(/Jina Reader —/));
  if (mode !== "full_text") {
    await user.click(screen.getByLabelText("Extraction mode"));
    await user.click(screen.getByText(label, { exact: true }));
  }
  if (mode === "selected_text") current.setFieldValue("extraction_rule", { version: 1, kind: "bounded_context", before: "Before", after: "After", max_length: 64 });
  await user.click(screen.getByLabelText("Text content source"));
  await user.click(screen.getByText(/Direct browser content/));
  expect(current.getFieldValue("text_source")).toBe("direct");
  expect(current.getFieldValue("extraction_mode")).toBe("full_text");
  if (mode === "selected_text") expect(current.getFieldValue("extraction_rule")).toMatchObject({ before: "Before" });
});

it("restores unsaved Jina extraction settings when switching back before save", async () => {
  const user = userEvent.setup();
  render(<Fixture />);
  await user.click(screen.getByText("Advanced settings", { exact: true }));
  await user.click(screen.getByLabelText("Text content source"));
  await user.click(screen.getByText(/Jina Reader —/));
  await user.click(screen.getByLabelText("Extraction mode"));
  await user.click(screen.getByText("Selected Text / Value", { exact: true }));
  const rule = { version: 1, kind: "bounded_context", before: "Availability", after: "Delivery", max_length: 64 };
  current.setFieldValue("extraction_rule", rule);
  await user.click(screen.getByLabelText("Text content source"));
  await user.click(screen.getByText(/Direct browser content/));
  await user.click(screen.getByLabelText("Text content source"));
  await user.click(screen.getByText(/Jina Reader —/));
  expect(current.getFieldValue("extraction_mode")).toBe("selected_text");
  expect(current.getFieldValue("extraction_rule")).toEqual(rule);
});

it("includes the applied Selected Text rule in the JSON payload used to save a new monitor", async () => {
  const user = userEvent.setup();
  render(<Fixture />);
  await user.click(screen.getByText("Advanced settings", { exact: true }));
  await user.click(screen.getByLabelText("Text content source"));
  await user.click(screen.getByText(/Jina Reader —/));
  await user.click(screen.getByLabelText("Extraction mode"));
  await user.click(screen.getByText("Selected Text / Value", { exact: true }));
  const rule = { version: 1, kind: "bounded_context", before: "Price\n", after: "\nSeller", max_length: 64 } as const;
  current.setFieldsValue({ name: "Selected value", url: "https://example.com/product", extraction_rule: rule });
  const requestBody = JSON.parse(JSON.stringify(await current.validateFields()));
  expect(requestBody).toMatchObject({
    text_source: "jina",
    extraction_mode: "selected_text",
    extraction_rule: rule,
  });
});

it("keeps an updated Selected Text rule in the JSON payload used to save an existing monitor", async () => {
  const user = userEvent.setup();
  render(<Fixture />);
  await user.click(screen.getByText("Advanced settings", { exact: true }));
  current.setFieldsValue({
    name: "Existing selected value", url: "https://example.com/product", text_source: "jina", extraction_mode: "selected_text",
    extraction_rule: { version: 1, kind: "bounded_context", before: "Old\n", after: "\nSeller", max_length: 64 },
  });
  await waitFor(() => expect(screen.getByRole("button", { name: "Select text from preview" })).toBeInTheDocument());
  const replacement = { version: 1, kind: "bounded_context", before: "Price\n", after: "\nSeller", max_length: 96 } as const;
  current.setFieldValue("extraction_rule", replacement);
  const requestBody = JSON.parse(JSON.stringify(await current.validateFields()));
  expect(requestBody.extraction_rule).toEqual(replacement);
});

it("rejects missing and malformed Selected Text rules before a save request", () => {
  expect(isValidSelectedTextRule(null)).toBe(false);
  expect(isValidSelectedTextRule({ version: 1, kind: "bounded_context", before: "", after: "", max_length: 64 })).toBe(false);
  expect(isValidSelectedTextRule({ version: 1, kind: "bounded_context", before: "Price", after: "", max_length: 0 })).toBe(false);
  expect(isValidSelectedTextRule({ version: 1, kind: "bounded_context", before: "Price", after: "", max_length: 64 })).toBe(true);
});
