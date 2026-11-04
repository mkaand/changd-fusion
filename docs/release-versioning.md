# Release versioning

Changd Fusion follows semantic versioning for public releases:

- **Patch** releases contain backward-compatible bug fixes.
- **Minor** releases contain backward-compatible features.
- **Major** releases contain breaking architectural changes that require an explicit migration plan.

Version `0.3.3` is a patch release: it corrects release/build provenance,
verifies Disable JavaScript behavior, and adds an opt-in updater that remains
disabled until an operator completes the documented bootstrap and activation.
