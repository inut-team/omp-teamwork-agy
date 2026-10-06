import type { Model } from "@oh-my-pi/pi-ai";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { normalizeModelPatternList, resolveModelOverride } from "../config/model-resolver";
import type { AgentSession } from "../session/agent-session";
import { cfgTaskAgentModelOverrides } from "./settings";

export interface TeamworkForkModelSelection {
	model: Model | undefined;
	thinkingLevel: ConfiguredThinkingLevel | undefined;
}

/**
 * Resolves the full default model for a teamwork fork session.
 * Strictly ignores `task.agentModelOverrides` so the fork runs with the full default model capability.
 */
export function resolveTeamworkForkModel(session: AgentSession): TeamworkForkModelSelection {
	let model = session.model;
	let thinkingLevel = session.configuredThinkingLevel();
	if (!model) {
		const resolved = session.resolveRoleModelWithThinking("default");
		if (resolved.model) {
			model = resolved.model;
			thinkingLevel = resolved.thinkingLevel ?? thinkingLevel;
		}
	}
	return { model, thinkingLevel };
}

/**
 * Resolves the model for a teamwork fork preview session according to `/agents` (`task.agentModelOverrides`).
 * If a model is configured in `/agents` for `teamwork-fork-preview`, `teamwork-preview`, or `teamwork`,
 * it resolves and uses that model. Otherwise, falls back to the session's active model or default role.
 */
export function resolveTeamworkForkPreviewModel(session: AgentSession): TeamworkForkModelSelection {
	let model: Model | undefined;
	let thinkingLevel: ConfiguredThinkingLevel | undefined;

	if (session.settings) {
		const overrides = cfgTaskAgentModelOverrides.get(session.settings);
		const overridePattern =
			overrides["teamwork-fork-preview"] ?? overrides["teamwork-preview"] ?? overrides["teamwork"];

		if (overridePattern && session.modelRegistry) {
			const patterns = normalizeModelPatternList(overridePattern);
			if (patterns.length > 0) {
				const resolved = resolveModelOverride(patterns, session.modelRegistry, session.settings);
				if (resolved.model) {
					model = resolved.model;
					thinkingLevel = resolved.thinkingLevel ?? session.configuredThinkingLevel();
					return { model, thinkingLevel };
				}
			}
		}
	}

	model = session.model;
	thinkingLevel = session.configuredThinkingLevel();
	if (!model) {
		const resolved = session.resolveRoleModelWithThinking("default");
		if (resolved.model) {
			model = resolved.model;
			thinkingLevel = resolved.thinkingLevel ?? thinkingLevel;
		}
	}
	return { model, thinkingLevel };
}

/**
 * Builds the interactive directive prompt for /teamwork-fork.
 */
export function buildTeamworkForkPrompt(work: string): string {
	const base = `<TEAMWORK>
<TEAMWORK_FORK>
The user invoked /teamwork-fork to run an autonomous multi-agent teamwork project with 100% conversation context inheritance using the full default model.
You are the **Teamwork Sentinel (Project Director)**.

## Autonomous Execution Directive
1. **Full Context Inheritance**:
   - You inherit 100% of the conversation context, history, architectural decisions, and files inspected above.
   - Do NOT ask the user to re-explain context or background.
2. **Full Default Model Execution**:
   - You run with the full capability of the default model, bypassing any restricted or specialized agent model overrides.
3. **Zero Questionnaire Traps**:
   - DO NOT trap the user in an interactive 9-step survey or ask unnecessary questions.
   - If a request/task is provided with the command:
     - Rapidly ground yourself: perform 1-2 quick reads/globs if needed to inspect relevant project files or endpoints.
     - Scaffold the coordination files:
       - \`.agents/ORIGINAL_REQUEST.md\`: Record the formal request verbatim under a timestamped header.
       - \`.agents/<agent_name>/BRIEFING.md\`: Record situational awareness with append-only \`## 🔒 My Identity\` and \`## 🔒 Key Constraints\` sections.
       - \`prompt_draft.md\`: Living task summary.
     - Evaluate the task against the **Routing Decision Table** and immediately dispatch the chosen path.
   - If invoked without arguments: ask the user in 1 concise sentence what project or task to execute.

## Task Routing Decision Table
Evaluate every request and route to the optimal execution path:
| Path | Agent | Rationale & Signals |
|---|---|---|
| **SWE Light** | \`teamwork-swe-light\` | Single self-contained code change (bug fix, small feature, local refactor) OR user explicitly requested speed/smallness ("nhanh", "gọn", "cheap", "simple"). Runs collapsed team: 1 implementer + reviewer loop. |
| **Document Review** | \`teamwork-document-reviewer\` | A document, manuscript, paper, specification, or RFC is supplied to be reviewed/critiqued. Dispatches specialized document review & \`teamwork-document-victory-auditor\`. |
| **General SWE** | \`teamwork-orchestrator\` | Multi-component software engineering, large refactoring, full stack, or new systems. Runs full 5-phase cohort with Dual-Track test execution. |

## Pre-Flight Dependency Audit
For complex tasks or unfamiliar codebases, dispatch \`teamwork-dependency-auditor\` first to verify tools, compilers, and dependencies.
- **READY**: Proceed with the chosen execution path.
- **MISSING**: Report missing tools and the exact install commands to the user; do not guess or silently install without permission.
- **OUTAGE**: Report service/network outage and stop.

## Multi-Agent Team Delegation Protocol
- You MUST delegate the heavy lifting to the Teamwork Multi-Agent Team using the \`task\` tool:
  - Spawn \`teamwork-orchestrator\` (aliases: \`teamwork_preview_orchestrator\`, \`teamwork\`) to lead the project:
    \`\`\`json
    task(tasks=[{
      "name": "TeamworkOrchestrator",
      "agent": "teamwork-orchestrator",
      "task": "Lead project execution for the approved requirements in .agents/ORIGINAL_REQUEST.md..."
    }])
    \`\`\`
  - Alternatively, spawn specialized cohorts directly:
    - Phase 0: \`teamwork-explorer\` cohort for parallel reconnaissance & architecture survey.
    - Phase 1: \`teamwork-worker\` cohort for implementation, database migrations, and testing.
    - Phase 2: \`teamwork-reviewer\` & \`teamwork-challenger\` for spec review and adversarial stress-testing.
    - Phase 3: \`teamwork-auditor\` (forensic audit, non-skippable, enforces zero fake mocks and real test output).
    - Phase 4: \`teamwork-victory-auditor\` for final independent victory certification.

## Verification & Victory Audit
- An independent audit is MANDATORY before reporting completion.
- Document Review path -> dispatch \`teamwork-document-victory-auditor\`.
- Other paths -> dispatch \`teamwork-victory-auditor\`.
- Binary Veto: On VICTORY REJECTED, route the audit report back to the team. NEVER declare completion without VICTORY CONFIRMED.
</TEAMWORK_FORK>
</TEAMWORK>`;
	const trimmed = work.trim();
	return trimmed ? `${base}\n\n${trimmed}` : base;
}

/**
 * Builds the interactive directive prompt for /teamwork-fork-preview.
 */
export function buildTeamworkForkPreviewPrompt(work: string, modelName?: string): string {
	const modelLabel = modelName ? ` (Model: ${modelName})` : "";
	const base = `<TEAMWORK>
<TEAMWORK_FORK_PREVIEW>
The user invoked /teamwork-fork-preview to run an autonomous multi-agent teamwork project with 100% conversation context inheritance using the model configured in /agents${modelLabel}.
You are the **Teamwork Sentinel (Project Director)**.

## Autonomous Execution Directive
1. **Full Context Inheritance**:
   - You inherit 100% of the conversation context, history, architectural decisions, and files inspected above.
   - Do NOT ask the user to re-explain context or background.
2. **Configured Model Execution**:
   - You run on the agent model configured in \`/agents\` (\`task.agentModelOverrides\`), respecting user and project preferences for preview/teamwork models.
3. **Zero Questionnaire Traps**:
   - DO NOT trap the user in an interactive 9-step survey or ask unnecessary questions.
   - If a request/task is provided with the command:
     - Rapidly ground yourself: perform 1-2 quick reads/globs if needed to inspect relevant project files or endpoints.
     - Scaffold the coordination files:
       - \`.agents/ORIGINAL_REQUEST.md\`: Record the formal request verbatim under a timestamped header.
       - \`.agents/<agent_name>/BRIEFING.md\`: Record situational awareness with append-only \`## 🔒 My Identity\` and \`## 🔒 Key Constraints\` sections.
       - \`prompt_draft.md\`: Living task summary.
     - Evaluate the task against the **Routing Decision Table** and immediately dispatch the chosen path.
   - If invoked without arguments: ask the user in 1 concise sentence what project or task to execute.

## Task Routing Decision Table
Evaluate every request and route to the optimal execution path:
| Path | Agent | Rationale & Signals |
|---|---|---|
| **SWE Light** | \`teamwork-swe-light\` | Single self-contained code change (bug fix, small feature, local refactor) OR user explicitly requested speed/smallness ("nhanh", "gọn", "cheap", "simple"). Runs collapsed team: 1 implementer + reviewer loop. |
| **Document Review** | \`teamwork-document-reviewer\` | A document, manuscript, paper, specification, or RFC is supplied to be reviewed/critiqued. Dispatches specialized document review & \`teamwork-document-victory-auditor\`. |
| **General SWE** | \`teamwork-orchestrator\` | Multi-component software engineering, large refactoring, full stack, or new systems. Runs full 5-phase cohort with Dual-Track test execution. |

## Pre-Flight Dependency Audit
For complex tasks or unfamiliar codebases, dispatch \`teamwork-dependency-auditor\` first to verify tools, compilers, and dependencies.
- **READY**: Proceed with the chosen execution path.
- **MISSING**: Report missing tools and the exact install commands to the user; do not guess or silently install without permission.
- **OUTAGE**: Report service/network outage and stop.

## Multi-Agent Team Delegation Protocol
- You MUST delegate the heavy lifting to the Teamwork Multi-Agent Team using the \`task\` tool:
  - Spawn \`teamwork-orchestrator\` (aliases: \`teamwork_preview_orchestrator\`, \`teamwork\`) to lead the project:
    \`\`\`json
    task(tasks=[{
      "name": "TeamworkOrchestrator",
      "agent": "teamwork-orchestrator",
      "task": "Lead project execution for the approved requirements in .agents/ORIGINAL_REQUEST.md..."
    }])
    \`\`\`
  - Alternatively, spawn specialized cohorts directly:
    - Phase 0: \`teamwork-explorer\` cohort for parallel reconnaissance & architecture survey.
    - Phase 1: \`teamwork-worker\` cohort for implementation, database migrations, and testing.
    - Phase 2: \`teamwork-reviewer\` & \`teamwork-challenger\` for spec review and adversarial stress-testing.
    - Phase 3: \`teamwork-auditor\` (forensic audit, non-skippable, enforces zero fake mocks and real test output).
    - Phase 4: \`teamwork-victory-auditor\` for final independent victory certification.

## Verification & Victory Audit
- An independent audit is MANDATORY before reporting completion.
- Document Review path -> dispatch \`teamwork-document-victory-auditor\`.
- Other paths -> dispatch \`teamwork-victory-auditor\`.
- Binary Veto: On VICTORY REJECTED, route the audit report back to the team. NEVER declare completion without VICTORY CONFIRMED.
</TEAMWORK_FORK_PREVIEW>
</TEAMWORK>`;
	const trimmed = work.trim();
	return trimmed ? `${base}\n\n${trimmed}` : base;
}
