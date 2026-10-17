# Chromium package and sandbox recovery

## Verified cause (2026-10-16)

The production API and Dev Container images pinned
`155.0.8059.39-1~deb12u1` against the live Bookworm repositories. Debian Security
replaced that version with `155.0.8059.79-1~deb12u1`; the older exact version is no
longer listed. A fresh, authenticated `apt-get update` succeeds, then installation
of the old pin fails before Chromium or any sandbox smoke test starts.

Evidence:

- [Last successful master CI](https://github.com/mkaand/changd-fusion/actions/runs/38866737497)
  downloaded and installed the old version at 07:22 UTC, then passed all Docker
  and Dev Container smoke tests.
- [First observed package-resolution failure](https://github.com/mkaand/changd-fusion/actions/runs/38929026994)
  at 16:04 UTC used the same Ubuntu 22.04 runner and Node base digest. Its APT
  index refresh succeeded, but both old package pins were absent.
- [Later reproduction](https://github.com/mkaand/changd-fusion/actions/runs/38960813596)
  failed at the same package installation step. Verify and Privacy succeeded.
- Fresh metadata inspection in the exact pinned Node image confirms the new
  matching browser/sandbox candidates on both amd64 and arm64. The current
  security candidate is newer than the removed pin; the older Bookworm main
  candidate `150.0.7871.100-1~deb12u1` is deliberately not selected.

This is a superseded package pin, not evidence of a Cloud runtime, Playwright,
dependency-resolution, architecture-specific or Chromium sandbox failure. The
successful and failing builds both executed APT rather than reusing that layer.

## Package provenance and architecture

Both Dockerfiles now pin `chromium`, `chromium-common` and `chromium-sandbox` to
`155.0.8059.79-1~deb12u1` from the official
`deb.debian.org/debian-security`, `bookworm-security/main` repository. Default
Debian archive signature verification remains enabled. No repository, trust key,
TLS behavior or base image is changed.

SHA-256 values in the authenticated package metadata:

| Package | Architecture | SHA-256 |
| --- | --- | --- |
| chromium | amd64 | `2c23c601790250498149efbfd2c5c043d5a5268d18f1b1b74894e4986d50b791` |
| chromium-sandbox | amd64 | `34a3a13f535a14cde1a50611f06e489944fd45b5160b7ac73ffb64f3604d940f` |
| chromium | arm64 | `a723cceaff406cbd5e8436d2a70fb5f39291a2b79545384d2680e6303d8b5a55` |
| chromium-sandbox | arm64 | `61926d8f69e1729aed1da34a7aee5b74152c3632f20c614911407716d785825c` |

The unchanged Node 24.19.0 multi-architecture base index is
`sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df`.
Its amd64 image manifest is
`sha256:e5a8dee7bc1e6a215d224a7ef8206f7e77271bc3cabd5febf2beafac0674f174`;
arm64/v8 is
`sha256:be8929e08ae137e81b5e1edba02259e6c4cb2f5ad655092bb9f56b97e41c4536`.
Both retain the official Node image provenance/attestations. Dev Container CLI
downloads retain their existing architecture-specific checksums.

An exact package pin prevents silently choosing another browser, including an
older main-repository version. Live security repositories do retire superseded
versions; future security updates require another explicit pin review, matching
package update and sandbox CI run. This is version-reproducible while the signed
packages remain published, not a promise of permanent archive availability or
bit-for-bit reproducibility of every transitive OS dependency. Builds fail closed
if the selected version disappears. There is no automatic unpin or downgrade.

## Validation and security boundaries

The existing `docker` job now uses `--pull --no-cache` for each API, UI and preview
build. A separate native ARM64 job repeats the real builds and smoke tests on
`ubuntu-24.04-arm`; no QEMU, privileged setup, host policy exceptions or emulation
are used. The existing amd64 runner remains Ubuntu 22.04.

Production smoke checks the installed browser/common/sandbox versions, UID 1000,
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

All browser and Docker lifecycle execution is performed on ephemeral GitHub CI.
Local inspection only refreshed package metadata in a disposable container;
it did not start Chromium. Production settings, databases, credentials,
baselines, history, deployment controllers and PR #20 are untouched.
