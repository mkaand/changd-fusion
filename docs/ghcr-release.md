# GHCR immutable release

`GHCR immutable release` is manual-only and can publish only when dispatched
from `master`. The operator supplies a complete 40-character source SHA. The
workflow rejects any SHA outside `master` history and requires successful
`verify`, `privacy`, `docker`, and `docker-arm64` GitHub Actions checks for
that exact SHA before it builds or publishes.

For v0.3.0 it publishes Linux AMD64 images tagged with the version and exact
source SHA. The release manifest records immutable digest references. Deploy
only these references, never a mutable tag:

```
ghcr.io/mkaand/changd-fusion-api@sha256:...
ghcr.io/mkaand/changd-fusion-ui@sha256:...
```

The API and Worker must use the same API digest. Both image OCI revision labels
must equal the selected source SHA; the UI build metadata must also show that
same SHA and `master`. Existing Chromium fencing, Worker readiness, migration
016 approval, and default-deny controller checks remain mandatory. The private
deployment controller must be rebound to the new merged `master` SHA before it
can consume this workflow; this change does not alter that controller and never
requires a production Docker build.

New repository-linked GHCR packages can be private initially. Before production
use, verify each package is linked to `mkaand/changd-fusion` and whether it is
public. A private package requires an authorized GHCR pull credential; no
production credential is created by this workflow.

## Later production image cleanup

Only after deployment acceptance and separate authorization:

1. Record free disk, Changd Fusion containers, their image IDs/digests, and all
   `changd-fusion-*` tags.
2. Protect every image used by a running container, the selected rollback
   digest, and images shared with another container.
3. Identify exact obsolete, project-specific locally built image references.
4. Remove only each verified obsolete reference individually; never force
   removal, prune globally, or remove database/capture volumes.
5. Record free disk again and retain the inventory with the release evidence.
