# Chromium package and sandbox recovery

## Verified cause and resolution

The API and Dev Container images previously pinned an exact Chromium version
against the live Bookworm repositories. Debian Security retires superseded
packages, so a later clean `apt-get update` could no longer install that exact
browser/common/sandbox set. This was an availability failure before Chromium,
Playwright, or sandbox startup.

Both Dockerfiles now resolve `chromium`, `chromium-common`, and
`chromium-sandbox` from the current official, signed Bookworm indexes. APT's
normal signature verification and HTTPS behavior remain enabled; no extra
repository, package mirror, downgrade, or browser-security bypass is used. The
build fails unless all three installed package versions are identical. It prints
the package versions and executable version, then records them in
`/usr/local/share/changd-fusion/chromium-version` inside the immutable image.

This intentionally trades a permanently reproducible Debian package pin for the
availability of current authenticated security updates. The Node 24 base-image
digest and application dependency lockfiles remain pinned. For an auditable
deployment, retain the built image digest together with the embedded Chromium
manifest; inspect it with `docker run --rm IMAGE cat
/usr/local/share/changd-fusion/chromium-version`.

Use the public self-hosting command in the README for a clean build. It refreshes
APT metadata during image construction. A managed network proxy may need to
provide its trusted CA through the optional BuildKit `build_ca` secret; ordinary
self-hosted servers using standard public CA trust need no Cloud-specific setup.

## Validation and security boundaries

The existing `docker` job now uses `--pull --no-cache` for each API, UI and preview
build. A separate native ARM64 job repeats the real builds and smoke tests on
`ubuntu-24.04-arm`; no QEMU, privileged setup, host policy exceptions or emulation
are used. The existing amd64 runner remains Ubuntu 22.04.

Production smoke checks the installed browser/common/sandbox version contract and
embedded manifest, UID 1000,
the unchanged 1 CPU / 1 GiB / 256 PID / 256 MiB SHM limits, network isolation,
Seccomp-BPF status at `chrome://sandbox`, Browser Steps, complete PNG dimensions
for viewport/full-page/CSS/XPath captures, and secure Region Picker selection.
It additionally rejects remaining Chromium/crashpad processes after normal
captures and a forced navigation timeout. Cleanup checks include zombies and are
bounded. The existing Chromium seccomp profile and Playwright
`chromiumSandbox: true` remain unchanged.

The preview image smoke verifies matching packages, UID 1000 and the real browser
sandbox using the application's pinned Playwright 1.64.0 dependency. The existing
real Dev Containers lifecycle validates HOME/VS Code ownership, private runtime
secret isolation, cross-UID recovery, PostgreSQL migrations in its disposable
database, application behavior, and repeat/resume. No check is replaced by a mock.

All browser and Docker lifecycle execution is performed on ephemeral GitHub CI
and disposable local containers. Production settings, databases, credentials,
baselines, history, deployment controllers and PRs are untouched.
