import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { browserViewport, dismissCookieConsent, hasManualCookieStep, isTrackerHostname, observeMainFrameStatus } from "../src/browser-experience.js";

test("tracker matching is hostname-bound and does not block first-party lookalikes", () => {
  assert.equal(isTrackerHostname("doubleclick.net"), true);
  assert.equal(isTrackerHostname("stats.doubleclick.net"), true);
  assert.equal(isTrackerHostname("doubleclick.net.example.org"), false);
  assert.equal(isTrackerHostname("my-google-analytics.com"), false);
  assert.equal(isTrackerHostname("example.org"), false);
});

test("desktop and mobile preview viewports are explicit and scale-independent", () => {
  assert.deepEqual(browserViewport(false), { width: 1280, height: 900 });
  assert.deepEqual(browserViewport(true), { width: 390, height: 844 });
});

test("manual cookie dismissal takes precedence over automatic consent handling", () => {
  assert.equal(hasManualCookieStep([{ action: "dismiss_cookie", selector: "#reject", selector_type: "css", timeout_ms: 5000, continue_on_error: true }]), true);
  assert.equal(hasManualCookieStep([{ action: "click", selector: "#other", selector_type: "css", timeout_ms: 5000, continue_on_error: false }]), false);
});

test("automatic consent handling clicks only reject-only controls inside a consent root", async () => {
  const clicked: string[] = [];
  const actions = [
    { label: "Accept all", value: null },
    { label: "Reject offer", value: null },
    { label: null, value: "I do not accept" },
  ];
  const page = {
    locator: () => ({ all: async () => [{
      isVisible: async () => true,
      locator: () => ({
        count: async () => actions.length,
        nth: (index: number) => ({
          isVisible: async () => true,
          getAttribute: async (name: string) => name === "aria-label" ? actions[index].label : name === "value" ? actions[index].value : null,
          textContent: async () => actions[index].label,
          click: async () => { clicked.push(actions[index].label ?? actions[index].value ?? ""); },
        }),
      }),
    }] }),
  } as any;
  assert.equal(await dismissCookieConsent(page, Date.now() + 1_000, []), true);
  assert.deepEqual(clicked, ["I do not accept"]);
  assert.equal(await dismissCookieConsent(page, Date.now() + 1_000, [{ action: "dismiss_cookie", selector: "#manual", selector_type: "css", timeout_ms: 1_000, continue_on_error: false }]), false);
  assert.deepEqual(clicked, ["I do not accept"]);
});

test("automatic consent selects only UCL's necessary-cookie control", async () => {
  const clicked: string[] = [];
  const actions = ["Accept all cookies", "Settings", "Accept necessary cookies"];
  const page = { locator: () => ({ all: async () => [{
    isVisible: async () => true,
    locator: () => ({ count: async () => actions.length, nth: (index: number) => ({
      isVisible: async () => true, getAttribute: async () => null,
      textContent: async () => actions[index], click: async () => { clicked.push(actions[index]); },
    }) }),
  }] }) } as any;
  assert.equal(await dismissCookieConsent(page, Date.now() + 1_000, []), true);
  assert.deepEqual(clicked, ["Accept necessary cookies"]);
});

test("main-frame status observer retains the final step-triggered navigation status", () => {
  const emitter = new EventEmitter();
  const frame = {};
  const page = Object.assign(emitter, { mainFrame: () => frame });
  const observer = observeMainFrameStatus(page as any);
  observer.setInitial(200);
  emitter.emit("response", { frame: () => frame, status: () => 403, request: () => ({ isNavigationRequest: () => true }) });
  emitter.emit("response", { frame: () => ({}), status: () => 500, request: () => ({ isNavigationRequest: () => true }) });
  assert.equal(observer.value(), 403);
  observer.dispose();
  emitter.emit("response", { frame: () => frame, status: () => 200, request: () => ({ isNavigationRequest: () => true }) });
  assert.equal(observer.value(), 403);
});
