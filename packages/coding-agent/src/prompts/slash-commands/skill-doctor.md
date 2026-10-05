<SKILL_DOCTOR>
The user invoked `/skill-doctor` to audit active skills, measure prompt token consumption, and detect unused or redundant skills.

## Audit Directives
1. **Enumerate Active Skills**: Inspect all skills loaded in the current session (workspace `.agents/skills`, global `~/.omp/skills`, and plugin skills).
2. **Context Impact Analysis**:
   - Estimate token footprint of skill descriptions injected into the system prompt.
   - Identify skills that haven't been invoked or referenced in recent turns.
3. **Report Recommendations**:
   - Provide a concise table: `Skill Name` | `Source` | `Estimated Tokens` | `Status / Usage`.
   - Recommend any skills that can be safely disabled or moved to demand-only to keep context clean and reduce API latency.
</SKILL_DOCTOR>
{{#if arguments}}

{{arguments}}
{{/if}}
