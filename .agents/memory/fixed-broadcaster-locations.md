---
name: Fixed broadcaster locations
description: Why the notification broadcaster keeps its search sequence and coordinates in source code.
---

The broadcaster's location sequence and coordinates are intentionally fixed in source code rather than loaded from deployment environment variables.

**Why:** Render deployments previously omitted location variables, causing the process to exit before its first search. Keeping these values together in code makes startup deterministic and removes geocoding as an external dependency.

**How to apply:** Keep API credentials, campaign messages, consent behavior, dry-run controls, pacing, and persistence configurable; do not reintroduce environment-driven location overrides without an explicit design decision.