# Servo Fetch feasibility and benchmark

## Scope and decision boundary

This branch contains a standalone, reproducible benchmark for Servo Fetch. It
does **not** add Servo to the Changd Fusion worker, change monitor data, or
certify Servo for production network access. The benchmark answers the narrower
question of whether Servo's rendering performance and output quality justify
engineering a Changd-specific adapter.

The runtime is Servo Fetch `0.15.1` from release commit
`fa90cf0b6f76def0b7d5e9baeb13b9aceeb232b4` (`MIT OR Apache-2.0`). The benchmark
pins the official amd64 image by manifest digest:

```text
ghcr.io/konippi/servo-fetch@sha256:cd026015488a45bb1647c61d75bf94731e78b1428ffc091c725e23409ec6ec7a
```

The earlier upstream audit also inspected commit
`914241df0c2deed3b1bcb10d4d637a9a2049883d`. The executable benchmark uses the
released artifact, not an unversioned checkout or a floating image tag. CI
checks the image version and source revision labels before execution.

## Reproducible benchmark

The manually triggerable `Servo Low Resource Benchmark` workflow builds the repository's
pinned Chromium image, pulls the pinned Servo image, and runs:

```bash
cd server
npm ci
BENCHMARK_OUTPUT_DIR=/tmp/servo-benchmark-results npm run benchmark:servo
```

The harness creates an internal-only Docker bridge and a synthetic fixture
server. The bridge has no external route. Proxy variables are cleared inside
all benchmark containers. Containers receive no production secrets, database,
Docker socket, persistent browser profile, notification configuration, or host
network. The fixture-only `--allow-private-addresses` flag is passed to Servo
solely because the target is on this isolated internal bridge; it must never be
copied into a production adapter.

Both engines use single-capture concurrency and the same limits within each
profile: A is 0.5 CPU / 768 MiB, B is 1 CPU / 768 MiB, and C is 2 CPUs / 1 GiB
(the V1 reference profile). Every profile uses 256 PIDs, 256 MiB shared memory,
a read-only root filesystem, and an
ephemeral `/tmp`, and the project's Chromium seccomp profile. Chromium runs as
the image's non-root `node` user with its setuid sandbox; Servo runs as its
official image's non-root `servo` user with all capabilities dropped and
`no-new-privileges` enabled.

Normal fixtures cover static HTML/CSS, JavaScript-rendered content, a large DOM
and CSS grid, SVG images and installed fonts, a long full-page layout, a delayed
DOM update, and delayed resources. The long and dynamic fixtures exercise
full-page and post-settle behavior, but do not claim Browser Steps or
same-session interactive scrolling parity, which Servo Fetch's public CLI does
not expose. Separate diagnostics cover a broken HTTP
response and a forced timeout. Each normal fixture has one cold run, one
unmeasured warm-up, and at least seven measured fresh-process runs per engine.
Cold and warm results remain separate.

The artifacts contain:

- `benchmark-results.json`: machine-readable environment, provenance, per-run
  timing, CPU time, cgroup throttling, memory, dimensions, PNG validity,
  cleanup, and comparison data;
- `benchmark-summary.md`: per-profile, per-fixture and aggregate human-readable results;
- `screenshots/*.png`: one deterministic representative image per engine and
  normal fixture;
- `SHA256SUMS`: hashes for the JSON, Markdown, and screenshots.

Capture-process wall time is the primary engine measurement. Peak cgroup memory,
process-tree RSS, CPU time, cgroup CPU periods/throttled periods and throttled
time are measured for each capture. Fresh-container
end-to-end time is also recorded separately because container rootfs startup
and cleanup are runner/storage-driver effects rather than browser capture time.
Chromium additionally reports launch, navigation, settle, and screenshot stage
times. Servo's CLI exposes only total runtime, so unavailable stage values are
left null rather than estimated.

The paired rendering classification is intentionally conservative: up to 5%
different pixels is `PASS`, above 5% through 25% is `PARTIAL`, and above 25% is
`FAIL`. PNG validity, expected dimensions, and deterministic fixture color/state
probes are evaluated independently. This prevents a valid but materially
different render from being labeled fully compatible. A syntactically valid PNG
from an expected-failure fixture is not a successful diagnostic: Servo Fetch's
error-page PNG is recorded as a failed failure-rejection result.

## Current runtime findings

The synthetic runtime tests establish the following without relying on README
claims:

- Servo starts repeatedly as a non-root process and generates valid PNG files.
- JavaScript executes and delayed DOM updates are visible after the configured
  settle interval.
- CSS grid, images, installed fonts, viewport captures, and long full-page
  captures render at the expected `1280 x 800` viewport width.
- Full-page height matches the deterministic content in the benchmark fixture.
- Explicit timeouts fail and leave no child process behind in the container.
- A deliberately broken HTTP response is **not** rejected by Servo Fetch
  `0.15.1`; it exits successfully with an engine-generated error-page PNG.
  Chromium rejects the same fixture. A Changd adapter must treat this as a
  compatibility defect, not a successful capture.

Exact measurements and pixel-difference percentages belong to the workflow
artifact because they depend on the CI runner. A local smoke run is only a
harness check and is not evidence of Amsterdam VPS performance.

## Existing Changd Fusion capture contract

Changd validates each browser target through `EgressPolicy` and routes Chromium
through a per-capture local proxy. That proxy resolves and validates every
connection, pins the connection to an authorized address, and mediates
redirects, subresources, and WebSockets. The same Playwright page is used for
text extraction and screenshots. Existing monitors may also depend on browser
steps, CSS/XPath regions, clipping, masks, stable element geometry, a fixed
`1280 x 900` viewport, cancellation, and bounded cleanup.

The benchmark deliberately does not claim to satisfy this application
contract.

## Capture-contract proof of concept

`experiments/servo-capture-contract-poc` is a small Rust executable built
against the pinned `servo-fetch = 0.15.1` crate. The isolated test serves the
existing synthetic JavaScript fixture, invokes exactly one
`FetchOptions::screenshot` call, and verifies that the returned single `Page`
contains both the post-JavaScript `inner_text` and a valid PNG. It emits only
bounded metadata (PNG dimensions and byte count), never the URL, rendered text,
or image content.

Run it on a disposable fixture-only machine with Rust 1.88:

```bash
cd server
npm run test:servo-contract-poc
```

`--allow-fixture-private` is used only by the executable test so its local
synthetic fixture can be reached. It is not an application integration, must
not be reused for monitor URLs, and does not alter Changd's egress policy.

The proof makes no false compatibility claim. In 0.15.1, the public `Page`
does **not** expose navigation response status, CSS/XPath element coordinates,
an XPath lookup API, ordered click/fill/scroll/wait steps, or a transport proxy
hook. The test reports those limits explicitly. Therefore it proves only the
same-page text+PNG primitive; it does not prove strict HTTP failure handling,
safe region cropping, Browser Steps, or production egress equivalence.

The POC pins the pre-release `pkcs1`/`pkcs8` transitive versions that upstream
0.15.1's own lock file uses. This avoids a fresh Cargo solver selecting newer,
incompatible release-candidate crypto APIs; it is a reproducibility pin, not a
runtime security-policy change.

## Servo feature and extensibility matrix

| Capability | Classification | Evidence and adapter consequence |
| --- | --- | --- |
| JavaScript and CSS rendering | **A: upstream** | Proved by the JavaScript, dynamic, static, and heavy-layout fixtures. |
| Viewport PNG | **A: upstream** | Proved through the released CLI. The upstream viewport is fixed at `1280 x 800`, not Changd's `1280 x 900`. |
| Full-page PNG | **A: upstream** | Proved by the long fixture. Upstream internally caps dimensions at 16384. |
| Same-render text and screenshot | **B: thin Rust adapter** | A `FetchOptions::screenshot` result contains PNG, rendered HTML, and `inner_text` from the same `Page`, but the released CLI returns only PNG. |
| CSS text extraction | **A: upstream** | `Page` supports CSS-scoped article/Markdown extraction. It does not expose a CSS element screenshot. |
| CSS element screenshot | **C: upstream change needed** | The public screenshot interface accepts URL/full-page only. Correct same-render element bounds are not exposed. |
| XPath element screenshot | **C: upstream change needed** | No public XPath lookup plus same-render screenshot clipping contract exists. |
| DOM-bound element cropping | **C: upstream change needed** | PNG cropping itself is straightforward, but a trusted bounding rectangle from the exact captured page is unavailable. Coordinates from a second fetch are unsafe. |
| Screenshot masking | **C: upstream change needed** | Post-processing is possible only after same-render mask geometry is exposed. Current public APIs do not provide it. |
| Browser Steps | **C: substantial upstream/adapter work** | One evaluation expression is not equivalent to Changd's ordered click/fill/wait/scroll flow or private-value restrictions. Fetch modes cannot combine arbitrary steps and screenshot capture. |
| Stable configurable viewport/device scale | **C: upstream change needed** | Release API exposes neither viewport dimensions nor device scale. |
| Strict failure status | **C: upstream change or robust status API** | The invalid-response fixture produces a successful error-page screenshot, and the returned page contract does not expose a response status sufficient for fail-closed handling. |
| Secure outbound proxy integration | **C: upstream change needed** | No supported hook forces navigation, redirects, subresources, and WebSockets through Changd's pinned-IP proxy. |
| Production SSRF equivalence | **D: blocked with current release** | Initial-host policy is not connection-time DNS pinning and cannot replace Changd's proxy. |

`A` means the released upstream interface already supports the capability. `B`
means a small adapter can use an existing supported library contract. `C` means
the current public interface is insufficient and upstream or a carefully
maintained fork would have to expose additional same-session behavior. `D`
means production enablement is unsafe or unknown until the stated blocker is
resolved.

## Security boundary

Servo Fetch strict mode rejects literal/private addresses and selected
hostnames, but it does not implement Changd's resolve-validate-pin property for
every connection. Its screenshot API has no supported proxy/transport hook.
Therefore the current release is not equivalent for DNS rebinding, redirects,
subresources, WebSockets, or the existing pinned-IP browser proxy.

The isolated benchmark provides no route from Servo to production or private
services and is safe for synthetic performance measurement. It is not a reason
to run Servo in the normal worker network. A future adapter must first gain an
upstream-supported transport hook or an independently reviewed external egress
boundary with equivalent connection-time enforcement. It must also reject
unsupported monitor capabilities rather than silently falling back while
labeling a capture as Servo.

## Existing-monitor compatibility

Viewport-only and full-page visual captures are promising at the rendering
layer. A Rust adapter could also return text and an image from the same Servo
page. However, existing CSS/XPath region captures, masks, Browser Steps,
configurable viewport assumptions, private-value steps, strict navigation
failure detection, and production egress controls are not currently compatible.

For that reason this branch contains no `CAPTURE_ENGINE=servo` application
switch. Jina Reader, HTML, API/JSON, scheduling, notifications, history,
baselines, and stored monitor configurations are unchanged.

## Recommendation gate

Further adapter work is justified only if the full CI benchmark shows a
material latency and/or resource advantage while its representative screenshots
remain complete. Even a strong performance result authorizes only a small
upstream prototype for proxy enforcement, strict navigation status, viewport
configuration, and same-session region geometry. It does not authorize a
production trial.

A separately approved production trial would still require a sanitized staging
copy with notifications disabled, no competing scheduler, successful egress
review, explicit capability checks, backup/rollback readiness, and a separately
designed silent visual rebaseline. None of those actions are performed here.
