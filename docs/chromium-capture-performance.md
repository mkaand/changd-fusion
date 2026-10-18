# Chromium capture performance review

PR #20 preserves a fresh sandboxed Chromium process for every monitor. The
pinned-IP proxy, TLS verification, private-workflow restrictions, blocked
WebSockets, capture deadline, image limits and cleanup watchdog remain in place.

## Changes under test

- Inspect the final navigation response at `commit`, rejecting unsuccessful HTTP
  responses before their error documents finish loading deferred scripts.
  Successful documents still wait for `DOMContentLoaded`. This is not a shortcut
  for capturing partially parsed or uninitialized pages.
- Scroll partially visible or offscreen regions with the native, instant DOM
  scroll operation. Visibility and unique selector checks remain mandatory.
  The existing bounded stability sampler still validates the final geometry
  after scrolling, including nested scroll containers and CSS/XPath targets.
- Reuse the viewport observation as the first stability sample only when no
  scroll occurred. A later animation-frame observation must still agree; moving
  elements need consecutive new samples and unstable elements still fail.
- Retain the existing PR changes that skip scrolling for fully visible regions
  and collect attention signals in one DOM evaluation.
- Advance the stage-timing checkpoint when recording a finished stage. The
  previous catch/finally path counted failing navigation twice, so a 3.5-second
  error capture could report 6.4 seconds of navigation. This is a diagnostic fix;
  old failure-stage timings must not be interpreted as independent wall times.

## Limits of navigation optimization

`DOMContentLoaded` waits for parsing and parser/defer/module script dependencies.
Skipping it for an arbitrary existing monitor would change capture semantics:
there is no saved application-readiness contract that proves its JavaScript
content is complete. Network latency and a CPU-bound renderer cannot safely be
eliminated with a different Playwright event name. Images, CSS and fonts are not
indiscriminately blocked, and JavaScript remains enabled.

The visual font wait remains capped at its existing 1.5 seconds. Browser Steps,
their time budgets and capture timeouts are unchanged. The early HTTP rejection
improves failure latency; it does not imply faster successful navigation.

## Reproducible comparison

`.github/workflows/capture-performance.yml` builds a benchmark-only runtime and
compares the complete capture implementation at
`21990d7784e9f9f94976c20fdf32bfc63bbe7a45` against the branch implementation.
Both use the same locked Playwright dependency and installed Chromium executable.
The production Dockerfile and its unavailable pinned Debian package are unchanged.

The runtime is UID 1000 with `--init`, no external network (`--network none`), the
existing Chromium seccomp policy, 0.5 CPU, 768 MiB RAM, 256 PIDs, 256 MiB shared
memory and capture concurrency one. A fixture-only EgressPolicy permits only the
ephemeral loopback fixture port, through the existing pinned-IP browser proxy.
There is no database, real target, persistent browser profile or notification
delivery. No production environment variable or resource limit is changed.

Each scenario excludes one warm-up and measures seven captures per revision,
alternating revision order. Every capture launches a fresh browser and profile;
"warm-up" means OS/filesystem warm-up, not a shared-browser capture. Total time
includes launch, navigation, readiness, extraction, screenshot and cleanup.
Numeric stage timings come from capture itself. Cgroup CPU usage and throttling
are differenced per sample. Cgroup memory and aggregate browser-process RSS are
sampled every 50 ms. RSS includes shared pages and is not unique physical memory;
sampled peaks can miss short spikes. Memory includes the benchmark process and
container page cache. These limitations apply to both revisions.

Fixtures cover static viewport, heavy JavaScript/DOM, delayed resources, deferred
scripts, visible/partial/offscreen/lazy targets, a nested scroll container, XPath,
Browser Steps, HTTP redirects, challenge detection, error pages with delayed
scripts and a target that never responds. Failure fixtures must not produce a
valid capture. Successful PNGs must decode, have the expected dimensions and
contain the target's expected pixels; extracted JavaScript/step text is checked.
The first measured PNG pair for each normal scenario is compared pixel by pixel.
Remaining Chromium/crashpad processes, including zombies, fail the benchmark.

Results are uploaded as `chromium-capture-performance`: `results.json`,
`summary.md` and synthetic PNG pairs. CI runner and Chromium measurements are
not measurements of the production VPS. Historical production latency (43.3 s
median / 61.9 s p95) must not be compared directly to fixture latency as a speedup.

## First executed comparison

[Benchmark run 38959918896](https://github.com/mkaand/changd-fusion/actions/runs/38959918896)
tested implementation `0696ae4b292f61d11d3ec1b2139f904d461cd892`. Its
[artifact](https://github.com/mkaand/changd-fusion/actions/runs/38959918896/artifacts/12072512210)
contains all 208 samples (including excluded warm-ups), JSON, Markdown and 20
synthetic PNGs. These are small synthetic workloads, not production-equivalent
websites. Seven observations make per-scenario p95 the largest observation;
differences of tens of milliseconds are not evidence of broad superiority.

| Scenario | Before p50 / p95 ms | After p50 / p95 ms | Scroll p50 before / after ms |
| --- | ---: | ---: | ---: |
| Static viewport | 790 / 900 | 713 / 815 | — |
| Heavy JavaScript/DOM | 1310 / 1492 | 1301 / 1399 | 6 / 6 |
| Slow unrelated resource | 612 / 781 | 705 / 776 | 4 / 4 |
| Deferred script / delayed DOMContentLoaded | 1917 / 2013 | 1897 / 1962 | 4 / 4 |
| Visible region | 667 / 795 | 719 / 798 | 67 / 4 |
| Partially visible region | 689 / 808 | 798 / 809 | 32 / 9 |
| Offscreen/lazy region | 801 / 821 | 789 / 889 | 28 / 9 |
| Nested scroll container / XPath | 693 / 869 | 669 / 877 | 30 / 9 |
| Browser Steps | 795 / 880 | 678 / 820 | 4 / 4 |
| Redirect | 803 / 845 | 607 / 750 | 4 / 4 |
| HTTP error with slow deferred script (correct rejection) | 3508 / 3783 | 407 / 490 | — |
| Never-responding target (correct timeout) | 2524 / 2696 | 2694 / 2704 | — |

Across 70 normal captures per revision, total p50/p95 was 793/1917 ms before and
750/1897 ms after. Normal success was 70/70 on both revisions. Challenge, HTTP
error and never-responding targets were rejected in every measured sample.
All 10 PNG pairs had identical decoded pixels; dimensions and lazy target pixels
passed. Every sample ended with zero remaining browser/crashpad processes.

Peak sampled cgroup memory was 235 MiB for both revisions. Normal per-fixture
median CPU ranged from 312–669 ms before and 304–653 ms after; these are not
paired aggregate CPU percentiles. Slow-resource, visible-region and
partial-region total medians regressed in this run despite lower scroll times.
The total gains are small and noisy; this does not establish elimination of the
production 45–60 second stalls. The strongest result is faster rejection of
known HTTP errors while successful deferred-script readiness remains intact.

The measured failure-stage times in the first artifact include the old
double-counting bug. Use the independently measured total wall time for failure
comparisons. A second identical run on the corrected diagnostic implementation
is available as run
[38960674235](https://github.com/mkaand/changd-fusion/actions/runs/38960674235).
Review its JSON/Markdown alongside the first run before inferring repeatability.

## Selected Area follow-up (not implemented)

The smallest follow-up is an explicit opt-in rectangle on the existing
owner-bound Region Picker screenshot. Convert touch/mouse drag and resize
coordinates from the displayed image to normalized intrinsic PNG coordinates;
validate finite dimensions and bounds on both sides. Keep the fixed 1280x900,
scale-one viewport. Capture a single validated PNG, then crop it with bounded
coordinates. CSS/XPath, existing monitors and old images remain unchanged.

Persisting an optional rectangle and a new capture mode requires a separate
schema/API validation review and authorization. Existing configurations must not
be rewritten. Any intentional visual rebaseline must be explicit and preserve
history. This PR does not add rectangle storage, a migration or a baseline reset.

Rectangle capture avoids selector lookup, element actionability, scrolling and
element stability checks. It cannot remove navigation, JavaScript, rendering or
image-decoding costs. A fixed rectangle can miss content moved below the viewport
or responsive layout changes; unlike element selection, it does not follow a DOM
target. A comparison on the same fixtures and workload is needed before choosing
it as a preferred mode.
