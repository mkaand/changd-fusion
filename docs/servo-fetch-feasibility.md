# Servo Fetch feasibility audit

## Scope

This document records the pre-integration audit for an experimental Servo
capture engine. It is intentionally not an integration guide: no Servo binary,
image, dependency, environment variable, or fallback has been added to Changd
Fusion while the security blocker below remains unresolved.

The review used upstream `konippi/servo-fetch` commit
`914241df0c2deed3b1bcb10d4d637a9a2049883d` (workspace version `0.15.1`),
licensed `MIT OR Apache-2.0`.

## Current Changd Fusion contract

Browser capture validates each target through `EgressPolicy` and routes
Chromium through a per-capture local proxy. The proxy validates DNS for every
connection, connects to the validated address rather than performing a second
hostname lookup, and mediates redirects, subresources, and WebSockets. The
same Playwright page is then used for text extraction and screenshots. It also
supports browser steps, XPath/CSS lookup, clipping, masking, stable element
geometry, fixed `1280 x 900` viewport rendering, cancellation, and cleanup.

## Upstream surface audit

| Capability | Status | Evidence / consequence |
| --- | --- | --- |
| JavaScript and CSS rendering | Available | Servo is embedded with SpiderMonkey and CSS layout. Rendering accuracy has not been benchmarked against Changd fixtures. |
| PNG viewport screenshot | Available, incompatible contract | `screenshot(url, { fullPage })` returns PNG, but its public Node API does not expose viewport dimensions, device scale, or a session handle. Upstream defaults to `1280 x 800`, not Changd's `1280 x 900`. |
| Full-page PNG | Available, incompatible limits | Upstream resizes its viewport and internally caps dimensions at 16384. It cannot accept Changd's configured dimensions/pixel limits before capture. |
| CSS region screenshot | Unsupported | Screenshot accepts URL and `fullPage` only. CSS selection is available for text extraction, not screenshot clipping. |
| XPath region screenshot | Unsupported | No XPath lookup or screenshot clipping API is exposed. |
| Dynamic-region masks | Unsupported | No screenshot mask API is exposed. |
| Browser Steps | Unsupported | The API offers one optional JavaScript expression, not Changd's click/fill/wait/scroll workflow or private-value safeguards. |
| Stable viewport/device scale | Unsupported | No public viewport or device-scale configuration. |
| Same-session text plus screenshot | Unsupported | The upstream CLI documents fresh workers for page tools. Its Node `screenshot()` call is independent from `fetch()` / `evaluate()`. Combined monitors could observe different page states. |
| Timeout and cancellation | Partially available | Timeout and `AbortSignal` are exposed, but worker termination/cleanup still needs an integration-specific, independently tested process boundary. |
| Container prerequisites | Partial | Upstream documents Linux EGL/font dependencies and `xvfb-run`; this has not been reconciled with Changd's rootless seccomp profile. |

## Security blocker: egress equivalence

Upstream's `NetworkPolicy::STRICT` rejects literal/private addresses and a
small hostname denylist before fetch. It does not resolve a hostname, validate
every resolved address, and pin the connection to that validated address. The
public screenshot API also has no proxy option. Consequently a public hostname
that resolves or rebinds to a private address after validation can bypass the
property enforced by Changd Fusion's `EgressPolicy` / `browserProxy` design.

The upstream policy therefore cannot be treated as equivalent for:

- DNS rebinding prevention;
- redirect and subresource connection-time validation;
- WebSocket mediation;
- enforcement through Changd's pinned-IP proxy.

Running Servo in the normal worker network would weaken SSRF protection. Using
the documented `allow-private-addresses` switch would weaken it further and is
not acceptable. A fallback to Chromium while reporting a Servo capture would
also be incorrect.

## Existing-monitor compatibility

The following existing configurations cannot be truthfully supported by the
current upstream public interface: element captures using CSS or XPath,
masked visual captures, Browser Steps, private-value workflows, and combined
text + visual captures requiring one consistent session. Jina Reader-only,
HTML, and API/JSON workflows should retain their existing paths and must not
be redirected to Servo.

Because these are stored monitor configurations rather than opt-in new
settings, enabling `CAPTURE_ENGINE=servo` globally would make existing monitors
lose required behavior. That violates the no-reconfiguration requirement.

## Baseline and benchmark status

No Servo baseline transition, visual rebaseline, benchmark, or process launch
was performed. A benchmark before security equivalence would be misleading:
the result would use an egress model that cannot be deployed safely.

If the blocker is resolved, a future adapter must adopt the first complete,
validated Servo visual capture as the visual baseline without creating a
notification; retain text baselines and all historical records; and rebaseline
again when explicitly returning to Chromium. This requires a separately
reviewed transition marker or equivalent state design before implementation.

## Required path before reconsideration

One of the following must exist before an adapter can be implemented:

1. An upstream-supported proxy/transport hook that routes *all* Servo traffic
   (navigation, redirects, subresources, and WebSockets) through Changd's
   pinned-IP policy; or
2. A separately reviewed network isolation design that enforces the same
   connection-time public-address policy outside Servo, without host networking,
   Docker socket access, or a permissive private-address escape hatch.

After that, the implementation must still add explicit feature negotiation:
unsupported monitor capabilities must fail closed with a structured,
user-visible compatibility result rather than silently fall back or degrade.
It must then be tested with synthetic fixtures for the existing capture
contract, cancellation cleanup, rendering dimensions, and engine transition.

## Future production trial proposal (not executed)

1. Build an isolated staging deployment from this branch only after the egress
   blocker and required feature support are implemented and independently
   tested.
2. Restore a sanitized copy of monitor configuration into staging, disable all
   notification delivery, and run one scheduler only.
3. Benchmark Chromium and Servo against synthetic and approved staging targets;
   record latency, p95, peak RSS, CPU, PNG dimensions, visual difference,
   timeout rate, and cleanup results.
4. Require an explicit approval before any production trial. Preserve a recent
   database plus capture-volume backup, select the engine with one environment
   control, and ensure no competing scheduler writes to the production database.
5. Roll back by restoring the Chromium application version and selecting the
   Chromium engine. If a Servo visual baseline was adopted, perform one explicit
   Chromium visual rebaseline without emitting a false change notification.

No production access, deployment, database operation, or configuration change
is part of this audit.
