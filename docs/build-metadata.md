# UI build metadata

The Settings > General > Application card displays only build-time metadata embedded in the frontend bundle. It never queries GitHub at runtime and it does not inspect a deployment host or a `.git` directory.

`frontend/package.json` supplies the version. The other fields are optional Docker build arguments:

| Build argument | Displayed field | Validation |
| --- | --- | --- |
| `APP_COMMIT` | Commit HEAD | 40-character hexadecimal SHA |
| `APP_BRANCH` | Branch | Safe Git branch-name subset |
| `APP_SOURCE_PR` | Source PR | Positive integer |

For a verified source build, generate values from the same checkout that is used as the Docker build context:

```sh
eval "$(node scripts/prepare-build-metadata.mjs)"
docker compose build ui
```

The helper emits shell `export` statements, so the values are inherited by the `docker compose` child process in the same shell. It obtains `APP_COMMIT` and `APP_BRANCH` from the local checked-out repository. A detached checkout still produces its verified commit SHA, but deliberately leaves `APP_BRANCH` empty. It accepts `APP_SOURCE_PR` only if the controller also supplies `APP_SOURCE_PR_COMMIT` with the exact same 40-character checkout SHA. It does not query GitHub, infer a PR, or accept an unbound PR number.

## Production controller contract

The production controller remains outside this repository and must run the helper before building the UI image. For a merged production deployment, it must check out the deployment commit first, optionally verify the merged PR through its own trusted GitHub integration, set both `APP_SOURCE_PR` and `APP_SOURCE_PR_COMMIT` only after that verification, then run the helper and pass its output as Docker Compose build arguments. The controller must build API and UI from that same immutable checkout and tag or retain the resulting image together. On rollback, it must repeat the process from the rollback checkout; reusing metadata from a newer build is not permitted.

If the controller cannot establish a branch or PR binding, it must leave that input empty. The UI will display `Unavailable` rather than claim unverified deployment provenance. The controller must evaluate the helper output in the same shell that invokes Docker Compose, for example `eval "$(node scripts/prepare-build-metadata.mjs)" && docker compose build ui`. No secret, runtime GitHub request, or production-controller change is performed by the application itself.

If an argument is omitted or malformed, the UI displays `Unavailable` rather than guessing. Existing deployments can continue to build without these arguments; no secret, GitHub token, network request, or production-controller change is required. To display commit and branch data automatically, a deployment controller must explicitly export the verified values before building the UI image.
