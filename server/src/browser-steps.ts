import { z } from "zod";
import type { Page } from "playwright";
import { HttpError } from "./errors.js";
const common = {
  timeout_ms: z.number().int().min(100).max(10000).default(5000),
  continue_on_error: z.boolean().default(false),
};
const target = {
  selector: z.string().trim().min(1).max(1000),
  selector_type: z.enum(["css", "xpath"]).default("css"),
};
const action = <const N extends string, T extends z.ZodRawShape = {}>(
  name: N,
  fields: T = {} as T,
) => z.object({ action: z.literal(name), ...common, ...fields }).strict();
export const stepSchema = z
  .discriminatedUnion("action", [
    action("wait_selector", target),
    action("wait_visible", target),
    action("click", target),
    action("scroll_to", target),
    action("dismiss_cookie", target),
    action("select_option", { ...target, value: z.string().max(500) }),
    action("fill_literal", { ...target, value: z.string().max(500) }),
    action("fill_private", {
      ...target,
      credential: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,49}$/),
    }),
    action("scroll_by", {
      x: z.number().int().min(-5000).max(5000).default(0),
      y: z.number().int().min(-5000).max(5000),
    }),
    action("delay", { duration_ms: z.number().int().min(0).max(5000) }),
    action("wait_navigation", {
      path: z
        .string()
        .min(1)
        .max(1000)
        .refine(
          (s) =>
            s.startsWith("/") &&
            !s.startsWith("//") &&
            !s.includes("#") &&
            !s.includes("\\"),
        ),
    }),
  ])
  .refine(
    (s) =>
      !s.continue_on_error ||
      ["wait_selector", "wait_visible", "dismiss_cookie", "scroll_to"].includes(
        s.action,
      ),
    {
      message:
        "Only optional waits, cookie dismissal and scrolling may continue on error",
    },
  );
export const stepsSchema = z.array(stepSchema).max(20).default([]);
export type BrowserStep = z.infer<typeof stepSchema>;
export const locate = (page: Page, selector: string, type = "css") =>
  page.locator(type === "xpath" ? "xpath=" + selector : "css=" + selector);
export class StepFailure extends HttpError {
  constructor(
    public step: number,
    public action: string,
  ) {
    super(
      422,
      `Browser step ${step} (${action}) failed. Check selector and timeout.`,
    );
  }
}
export type BrowserStepWarning = {
  code: "optional_step_failed";
  step: number;
  action: BrowserStep["action"];
  category: "selector_unavailable" | "navigation_unavailable" | "step_timeout" | "step_failed";
};

function safeStepFailureCategory(step: BrowserStep, error: unknown): BrowserStepWarning["category"] {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("timeout")) return "step_timeout";
  if (step.action === "wait_navigation") return "navigation_unavailable";
  if ("selector" in step) return "selector_unavailable";
  return "step_failed";
}

export function warningCode(warning: BrowserStepWarning | undefined): string | undefined {
  return warning
    ? `${warning.code}:${warning.step}:${warning.action}:${warning.category}`
    : undefined;
}
export async function runSteps(
  page: Page,
  input: unknown,
  deadline: number,
  values: Record<string, string> = {},
) {
  const steps = stepsSchema.parse(input ?? []);
  let warning: BrowserStepWarning | undefined;
  const timer = setTimeout(
    () => void page.close().catch(() => {}),
    Math.max(1, deadline - Date.now()),
  );
  try {
    for (const [index, step] of steps.entries()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new HttpError(422, "Browser workflow exceeded its time budget");
      const timeout = Math.min(step.timeout_ms, remaining);
      try {
        const node =
          "selector" in step
            ? locate(page, step.selector, step.selector_type)
            : undefined;
        switch (step.action) {
          case "wait_selector":
            await node!.waitFor({ state: "attached", timeout });
            break;
          case "wait_visible":
            await node!.waitFor({ state: "visible", timeout });
            break;
          case "click":
          case "dismiss_cookie":
            await node!.click({ timeout });
            break;
          case "scroll_to":
            await node!.scrollIntoViewIfNeeded({ timeout });
            break;
          case "scroll_by": {
            const stepTimer = setTimeout(
              () => void page.close().catch(() => {}),
              timeout,
            );
            try {
              await page.evaluate(({ x, y }) => window.scrollBy(x, y), {
                x: step.x,
                y: step.y,
              });
            } finally {
              clearTimeout(stepTimer);
            }
            break;
          }
          case "delay":
            if (step.duration_ms > timeout) throw Error();
            await page.waitForTimeout(step.duration_ms);
            break;
          // An explicit path prevents accepting an unrelated navigation. Origin is never changed by this action.
          case "wait_navigation": {
            const expected = new URL(step.path, new URL(page.url()).origin)
              .href;
            await page.waitForURL(expected, {
              timeout,
              waitUntil: "domcontentloaded",
            });
            break;
          }
          case "select_option":
            await node!.selectOption(step.value, { timeout });
            break;
          case "fill_literal":
            await node!.fill(step.value, { timeout });
            break;
          case "fill_private":
            if (!Object.hasOwn(values, step.credential)) throw Error();
            await node!.fill(values[step.credential], { timeout });
            break;
        }
      } catch (error) {
        if (!step.continue_on_error)
          throw new StepFailure(index + 1, step.action);
        warning = {
          code: "optional_step_failed",
          step: index + 1,
          action: step.action,
          category: safeStepFailureCategory(step, error),
        };
      }
      if (Date.now() > deadline)
        throw new HttpError(422, "Browser workflow exceeded its time budget");
    }
    return warning;
  } finally {
    clearTimeout(timer);
  }
}
