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
  expect(screen.getByLabelText("Text monitoring mode")).toBeInTheDocument();
  await user.click(screen.getByLabelText("Text content source"));
  await user.click(screen.getByText(/Jina Reader/));
  expect(screen.getByLabelText("Text monitoring mode")).toBeInTheDocument();
  expect(screen.queryByText("Product Price", { exact: true })).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Text extraction method")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Add browser step" })).not.toBeInTheDocument();
  await user.click(screen.getByLabelText("Text monitoring mode"));
  await user.click(screen.getByText("Selected Text / Value", { exact: true }));
  expect(screen.getByRole("button", { name: "Select text from preview" })).toBeInTheDocument();
});

it("uses one shared notification direction and configures Direct Browser keyword presence", async () => {
  const user = userEvent.setup();
  render(<Fixture />);
  await user.click(screen.getByText("Advanced settings", { exact: true }));
  expect(screen.getAllByLabelText("Notification direction")).toHaveLength(1);
  await user.click(screen.getByText("Keyword Presence", { exact: true }));
  const keyword = screen.getByLabelText("Keyword");
  expect(keyword).toBeInTheDocument();
  expect(keyword).toHaveValue("");
  expect(keyword).not.toHaveAttribute("placeholder");
  expect(screen.queryByRole("button", { name: "Select text from preview" })).not.toBeInTheDocument();
  expect(screen.getByLabelText("Text selector (empty = visible page text)")).toBeInTheDocument();
  await expect(current.validateFields(["keyword"])).rejects.toBeDefined();
  await user.type(keyword, "Kaan");
  await user.click(screen.getByLabelText("Removed only"));
  current.setFieldsValue({ name: "Keyword monitor", url: "https://example.com" });
  const payload = JSON.parse(JSON.stringify(await current.validateFields()));
  expect(payload).toMatchObject({
    text_source: "direct",
    extraction_mode: "keyword_presence",
    keyword: "Kaan",
    text_direction: "removed",
  });
});

it("keeps an existing keyword value when the editor validates it", async () => {
  const user = userEvent.setup();
  render(<Fixture />);
  await user.click(screen.getByText("Advanced settings", { exact: true }));
  await user.click(screen.getByText("Keyword Presence", { exact: true }));
  current.setFieldsValue({ keyword: "Existing keyword", name: "Existing keyword monitor", url: "https://example.com" });
  await waitFor(() => expect(screen.getByLabelText("Keyword")).toHaveValue("Existing keyword"));
  const payload = await current.validateFields() as { keyword?: string };
  expect(payload.keyword).toBe("Existing keyword");
});

it("offers Keyword Presence for Jina while keeping Selected Text picker-only UI isolated", async () => {
  const user = userEvent.setup();
  render(<Fixture />);
  await user.click(screen.getByText("Advanced settings", { exact: true }));
  await user.click(screen.getByLabelText("Text content source"));
  await user.click(screen.getByText(/Jina Reader —/));
  await user.click(screen.getByText("Keyword Presence", { exact: true }));
  expect(screen.getByLabelText("Keyword")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Select text from preview" })).not.toBeInTheDocument();
  expect(screen.getByText(/Watches whether a literal word or phrase exists/)).toBeInTheDocument();
  await user.click(screen.getByText("Selected Text / Value", { exact: true }));
  expect(screen.queryByLabelText("Keyword")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Select text from preview" })).toBeInTheDocument();
  expect(screen.getAllByLabelText("Notification direction")).toHaveLength(1);
});

it("preserves legacy notification direction values", async () => {
  const user = userEvent.setup();
  render(<Fixture />);
  await user.click(screen.getByText("Advanced settings", { exact: true }));
  current.setFieldsValue({ name: "Legacy direction", url: "https://example.com", text_direction: "added" });
  await waitFor(() => expect(screen.getByLabelText("Added only")).toBeChecked());
  expect((await current.validateFields() as any).text_direction).toBe("added");
});

it.each([
  ["Full Text Changes", "full_text"],
  ["Selected Text / Value", "selected_text"],
])("submits Direct Browser with full text after switching from Jina %s", async (label, mode) => {
  const user = userEvent.setup();
  render(<Fixture />);
  await user.click(screen.getByText("Advanced settings", { exact: true }));
  await user.click(screen.getByLabelText("Text content source"));
  await user.click(screen.getByText(/Jina Reader —/));
  if (mode !== "full_text") {
    await user.click(screen.getByLabelText("Text monitoring mode"));
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
  await user.click(screen.getByLabelText("Text monitoring mode"));
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
  await user.click(screen.getByLabelText("Text monitoring mode"));
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

it("accepts V2 anchored rules and rejects malformed V2 rule payloads", () => {
  const v2 = { version: 2, kind: "anchored_lines", anchors: [{ text: "Product", offset: -2 }, { text: "Price", offset: -1 }, { text: "Seller", offset: 1 }], prefix: "", suffix: "", max_length: 64 };
  expect(isValidSelectedTextRule(v2)).toBe(true);
  expect(isValidSelectedTextRule({ ...v2, anchors: [{ text: "Product", offset: 0 }, { text: "Price", offset: -1 }] })).toBe(false);
  expect(isValidSelectedTextRule({ ...v2, anchors: [{ text: "Product", offset: -2 }] })).toBe(false);
  expect(isValidSelectedTextRule({ ...v2, prefix: "x".repeat(161) })).toBe(false);
  expect(isValidSelectedTextRule({ ...v2, unexpected: true })).toBe(false);
});

it("keeps a V1 monitor editable and carries an applied V2 rule into the save payload", async () => {
  const user = userEvent.setup();
  render(<Fixture />);
  await user.click(screen.getByText("Advanced settings", { exact: true }));
  current.setFieldsValue({ name: "Existing selected value", url: "https://example.com/product", text_source: "jina", extraction_mode: "selected_text", extraction_rule: { version: 1, kind: "bounded_context", before: "Price", after: "Seller", max_length: 64 } });
  const v2 = { version: 2, kind: "anchored_lines", anchors: [{ text: "Product", offset: -2 }, { text: "Price", offset: -1 }, { text: "Seller", offset: 1 }], prefix: "", suffix: "", max_length: 64 };
  current.setFieldValue("extraction_rule", v2);
  expect(JSON.parse(JSON.stringify(await current.validateFields())).extraction_rule).toEqual(v2);
});
