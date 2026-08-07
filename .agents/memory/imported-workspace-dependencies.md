---
name: Imported workspace dependencies
description: Environment-specific setup behavior for this imported pnpm monorepo.
---

After importing this workspace, the artifact workflows may be configured but fail immediately because `node_modules` is absent. Restore dependencies with `pnpm install --frozen-lockfile` before checking workflow or TypeScript failures.

**Why:** The workflow errors otherwise report missing tools such as `vite`, `esbuild`, and `tsc`, which can be mistaken for application defects.

**How to apply:** Run the locked install once after an import or clean checkout, then restart the managed artifact workflows and inspect their logs.