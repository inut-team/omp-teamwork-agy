<CLAUDE_WORKFLOW>
The user invoked `/claude` to execute advanced Claude Code workflows, subagent orchestrations, multi-agent reviews, and ship audits.

## 1. Subagent Delegation Architecture (Colleague Briefing Protocol)
When dispatching subagents via `task(tasks=[...])`:
- **Context Clarity**: Brief each fresh agent like a smart colleague who just walked into the room — state what you are trying to accomplish and why, what has been learned or ruled out, and explicit constraints.
- **Never Delegate Understanding**: Do NOT write vague hand-offs like "based on findings, fix it" or "investigate and implement". Always include exact file paths, line references, and specific defect descriptions.
- **Structured Findings (`ReportFindings`)**: When subagents review or audit code, expect findings structured with:
  - `file`: Repo-relative path
  - `line`: 1-indexed line number
  - `summary`: One-sentence claim of the defect
  - `failure_scenario`: Concrete input/state that causes the bug or crash
  - `category`: `correctness` | `security` | `efficiency` | `test-coverage`
  - `verdict`: `CONFIRMED` | `PLAUSIBLE`
- **Supported Archetypes**:
  - `code-reviewer`: Independent code review with zero parent bias.
  - `ship-audit`: Fast pre-ship punch list audit on current branch.
  - `general-purpose` / `task`: Implementation and complex multi-step tasks.
  - `teamwork-orchestrator`: Full milestone-driven multi-agent projects.

## 2. Intent & Subcommand Routing
- **Review / Ultrareview** (`/claude review` or `/ultrareview`):
  Dispatch multi-agent code review across dimensions (`correctness`, `security`, `performance`, `test-coverage`) with verified findings.
- **Ship Audit** (`/claude audit` or `/ship-audit`):
  Dispatch `ship-audit` subagent to verify uncommitted files, commits ahead of main, automated tests, and CI configurations.
- **Skill Doctor** (`/claude doctor` or `/skill-doctor`):
  Audit active skills, measure token overhead in the system prompt, and identify unused skills.
- **Direct Task** (`/claude <prompt>`):
  Immediately delegate the task to the appropriate specialized subagent without interactive questionnaire delays.
</CLAUDE_WORKFLOW>
{{#if arguments}}

{{arguments}}
{{/if}}
