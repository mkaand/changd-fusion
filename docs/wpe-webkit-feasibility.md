# Native WPE WebKit 2.54.1 feasibility

## Scope

This branch records a native WPE WebKit runtime check only. It does not add WPE
to Changd Fusion, change the production image, or weaken any sandbox setting.

## Reproducible Sid package set

An isolated Debian Sid container resolved the following native packages:

| Package | Version |
| --- | --- |
| `libwpewebkit-2.0-1` | `2.54.1-1` |
| `libwpewebkit-2.0-dev` | `2.54.1-1` |
| `wpewebkit-webdriver` | `2.54.1-1` |
| `libwpe-1.0-1` | `1.16.3-2` |
| `libwpebackend-fdo-1.0-1` | `1.16.1-1+b1` |

`pkg-config --modversion wpe-webkit-2.0` reported `2.54.1`. The development
package exposes the native `webkit_web_view_get_snapshot()` and
`webkit_web_view_get_snapshot_finish()` APIs, `WebKitImage` byte/stride access,
and the `wpe-platform-headless-2.0` development package configuration.

## Native headless runtime result

`WPE_PLATFORM=headless WPEWebDriver` created a native WPE `MiniBrowser` session
whose WebDriver capabilities reported `browserVersion: 2.54.1`. This proves that
the checked executable was native WPE WebKit, not Chromium, Playwright, or GTK
WebKit.

The rendered process then failed before a page or snapshot could be captured:

```text
bwrap: Creating new namespace failed: Operation not permitted
Connection: failed to receive credentials: Expecting to read a single byte for receiving credentials but read zero bytes
```

The failure occurs because WPE's WebProcess uses Bubblewrap and the benchmark
container's existing restricted namespace policy does not permit the required
user namespace. Passing an unconfined seccomp profile, granting additional
namespace privileges, or disabling WebKit's sandbox would make the test run,
but would invalidate the security constraints for this experiment. Those
workarounds are intentionally not used.

## Decision

No PNG, JavaScript/CSS, timeout, cleanup, or comparative benchmark claim is
made. A native WPE benchmark can proceed only in a CI executor that supports
the required unprivileged user namespace while retaining WPE's own sandbox and
the benchmark's internal fixture isolation. The production image, application
egress policy, monitor data, and Servo benchmark remain unchanged.

## Hosted-runner recovery probe

`Native WPE Headless Feasibility` creates an ephemeral Debian Sid chroot on a
GitHub-hosted Ubuntu runner. It installs the exact `2.54.1-1` Sid packages in
that chroot, runs an unprivileged Bubblewrap namespace preflight, then launches
`WPE_PLATFORM=headless WPEWebDriver`. The probe uses a local `data:` JavaScript
fixture and the native WPE WebDriver screenshot endpoint. It neither changes
the runner's sandbox configuration nor uses Docker, Chromium, Playwright, GTK
WebKit, production data, or external page targets.
