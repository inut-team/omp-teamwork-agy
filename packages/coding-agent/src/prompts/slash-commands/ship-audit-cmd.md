<SHIP_AUDIT>
The user invoked `/ship-audit` to perform an automated pre-ship verification on the current branch.

## Audit Directives
1. **Dispatch Ship Auditor**:
   - Spawn the `ship-audit` subagent via `task` to inspect uncommitted changes, commits ahead of main, test results, and CI workflows.
2. **Execute Full Punch List**:
   - Check `git status -s` for uncommitted or dirty files.
   - Check `git log origin/main..HEAD --oneline` (or tracking branch) for clean conventional commits.
   - Run the repo's automated tests (`bun test`, `npm test`, `cargo test`, or relevant test runner).
   - Check if CI/CD workflows or release configs are intact.
3. **Report**:
   - Deliver a clear under-200-word punch list:
     - ✅ **Done**: Passing checks and tests.
     - ❌ **Blockers**: Any failures or uncommitted changes.
     - ⚠️ **Cautions**: Untested edge cases or areas lacking coverage.
</SHIP_AUDIT>
{{#if arguments}}

{{arguments}}
{{/if}}
