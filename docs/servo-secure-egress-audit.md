# Servo Fetch 0.15.1 secure egress audit

## Decision

Servo Fetch `0.15.1` must not be connected to Changd Fusion's production
capture worker. Its public Rust API cannot prove that all browser traffic is
routed through Changd's per-capture pinned-IP proxy.

This is a fail-closed security decision, not a rendering or benchmark result.
The isolated benchmark and same-session capture POC remain valid only for
synthetic fixtures.

## Changd's required contract

Changd's `EgressPolicy` resolves each destination, rejects non-public
addresses, and its local browser proxy opens the upstream socket to the
validated address. Chromium is configured with that proxy, so HTTP requests,
HTTPS CONNECT tunnels, redirects, subresources, and WebSockets are mediated at
connection time. TLS still uses the original hostname.

An alternative engine must provide an equivalent, mandatory transport path for
every network request. Checking only an initial URL or setting an environment
variable is insufficient.

## Observed Servo Fetch 0.15.1 limitations

- `FetchOptions` and `Page` expose no per-capture proxy, connector, DNS, or
  socket-dial hook.
- `NetworkPolicy::STRICT` rejects literal private hostnames and IP addresses,
  but does not expose DNS resolution or connection-time IP pinning to callers.
- The public API does not provide evidence that redirects, JavaScript fetch/XHR,
  CSS/images/fonts, and WebSockets use one caller-controlled transport.
- No public switch guarantees that an unsupported proxy transport fails closed
  rather than using a direct connection.

The fixture-only `NetworkPolicy::PERMISSIVE` used by the capture-contract POC
is deliberately not an application setting and cannot be reused for monitors.

## Upstream PR #436

Upstream [PR #436](https://github.com/konippi/servo-fetch/pull/436) is open and
targets a Servo `0.5.0` upgrade for proxy environment-variable support and
HTTPS CONNECT authentication. It does not apply to the pinned `0.15.1`
dependency. More importantly, an environment-derived proxy alone would not
prove Changd's required per-capture forced-proxy, no-direct-fallback, or
connection-time pinning guarantees.

## Smallest viable upstream extension

Servo Fetch needs a version-pinned, per-`FetchOptions` transport policy with
all of the following properties:

1. a mandatory HTTP proxy endpoint, not an ambient environment variable;
2. an explicit no-direct-fallback guarantee for HTTP, HTTPS CONNECT, `ws`, and
   `wss`;
3. uniform use by initial navigations, redirects, subresources, script-initiated
   requests, and WebSockets;
4. deterministic reporting when a scheme or connection cannot use that path;
5. an executable integration test that records every request at the proxy.

With this extension, Changd's existing local proxy could remain the authority
that resolves, validates, and pins IP addresses. Without it, a Changd adapter
would need a substantial Servo networking fork and must not be attempted in
the production worker.

## Required future tests

Only after such a hook exists, an isolated test must demonstrate that allowed
traffic reaches the proxy and that the following never reach their synthetic
targets: loopback/private/metadata destinations, rebinding results, redirect
escapes, subresource bypasses, direct connections, and WebSocket bypasses.
The test must also validate HTTPS CONNECT, cancellation, proxy socket cleanup,
and that a denied capture cannot create a valid baseline.
