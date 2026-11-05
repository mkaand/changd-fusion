# Release versioning

Changd Fusion follows semantic versioning for public releases:

- **Patch** releases contain backward-compatible bug fixes.
- **Minor** releases contain backward-compatible features.
- **Major** releases contain breaking architectural changes that require an explicit migration plan.

Version `0.3.3` is a patch release: it corrects release/build provenance,
verifies Disable JavaScript behavior, and adds an opt-in updater that remains
disabled until an operator completes the documented bootstrap and activation.

Version `0.4.0` is a backward-compatible minor release: interactive Preview
requests have absolute FIFO priority over scheduled Chromium work, the three
visual editing flows share the retained browser Preview engine with replayable
real-page scrolling, and successful trusted master CI can start immutable GHCR
publication automatically. Production updater activation remains a separate,
one-time operator procedure.
