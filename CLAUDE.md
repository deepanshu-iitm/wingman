# Wingman — Claude Instructions

## Pre-PR / Pre-deploy workflow (REQUIRED)

Before creating a PR or pushing anything to deployment, always:

1. **Pull latest from the remote:**
   ```bash
   git fetch origin
   git status
   git log HEAD..origin/main --oneline   # see what's ahead on main
   ```

2. **Merge or rebase main into the current branch:**
   ```bash
   git merge origin/main
   ```

3. **Check for conflicts:**
   - If `git merge` reports conflicts, stop and list every conflicting file with a summary of what each side changed.
   - Suggest a concrete resolution for each conflict — don't just show the diff, explain which change to keep and why.
   - Never resolve a conflict by silently dropping a teammate's work.

4. **Verify nothing is broken after the merge:**
   - Run the TypeScript type-check for the module: `cd spacetimedb/spacetimedb && npx tsc --noEmit`
   - Run the type-check for the client: `cd src && npx tsc --noEmit`
   - If either fails, fix before proceeding.

5. **Only then** create the PR or publish/deploy.

If the pull introduces new remote commits, summarise what changed (file list + one-line per commit) before continuing.
