# UI build metadata

The Settings > General > Application card displays only build-time metadata embedded in the frontend bundle. It never queries GitHub at runtime and it does not inspect a deployment host or a `.git` directory.

`frontend/package.json` supplies the version. The other fields are optional Docker build arguments:

| Build argument | Displayed field | Validation |
| --- | --- | --- |
| `APP_COMMIT` | Commit HEAD | 40-character hexadecimal SHA |
| `APP_BRANCH` | Branch | Safe Git branch-name subset |
| `APP_SOURCE_PR` | Source PR | Positive integer |

For a verified source build, provide values from the same checkout that is used as the Docker build context, for example:

```sh
APP_COMMIT="$(git rev-parse HEAD)" \
APP_BRANCH="$(git branch --show-current)" \
APP_SOURCE_PR="" \
docker compose build ui
```

Only set `APP_SOURCE_PR` when the build process has independently established that the checked-out commit belongs to that pull request. An unmerged pull request must not be labelled as the production source build.

If an argument is omitted or malformed, the UI displays `Unavailable` rather than guessing. Existing deployments can continue to build without these arguments; no secret, GitHub token, network request, or production-controller change is required. To display commit and branch data automatically, a deployment controller must explicitly export the verified values before building the UI image.
