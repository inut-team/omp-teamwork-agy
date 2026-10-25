import { prompt } from "@oh-my-pi/pi-utils";
import grillMePrompt from "../prompts/slash-commands/grill-me.md" with { type: "text" };
import type { SlashCommandSpec } from "./types";
import { formatTeamworkStatus, inspectTeamworkStatus } from "../task/teamwork-status";
import {
	buildTeamworkForkPreviewPrompt,
	buildTeamworkForkPrompt,
	resolveTeamworkForkModel,
	resolveTeamworkForkPreviewModel,
} from "../task/teamwork-fork-model";

export function buildGrillMePrompt(args?: string): string {
	const trimmed = args?.trim();
	return prompt.render(grillMePrompt, { arguments: trimmed || undefined }).trim();
}

export const BUILTIN_AGY_COMPAT_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "grill-me",
		aliases: ["grill"],
		icon: "question",
		description: "Interview me to align on a plan (agy compat)",
		inlineHint: "[task or design to interview about]",
		allowArgs: true,
		handle: async (command, _runtime) => {
			return { prompt: buildGrillMePrompt(command.args) };
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			return { prompt: buildGrillMePrompt(command.args) };
		},
	},
	{
		name: "learn",
		icon: "memory",
		description: "Start the learning workflow to persist reusable behaviors (agy compat)",
		inlineHint: "[optional context]",
		allowArgs: true,
		handle: async (command, _runtime) => {
			const base = `<LEARN>\nThe user invoked /learn to persist reusable behaviors from recent interactions, corrections, or successes. Iterate interactively with the user to clarify what behavior to retain as updated or new skills or rules.\n## Identify What to Learn\n1. **Analyze User Messages**: Prioritize analyzing recent user messages for explicit corrections, constraints, overrides, or pointers (e.g., "no", "instead", "that failed").\n2. **Identify the Fix**: Compare failed attempts with the successful resolution to isolate the pivotal change.\n3. **Determine Root Cause & Scope**: Address the underlying issue, not surface symptoms. Determine if it's universal or domain-specific.\n4. **Verify if learning is needed**: If the interaction did not reveal any new reusable behaviors or constraints, explain this to the user and exit without proposing changes.\n2. Create/update a learning_proposal.md artifact outlining your classification, rationale, and precise text additions/diffs.\n</LEARN>`;
			const prompt = command.args ? `${base}\n\n${command.args.trim()}` : base;
			return { prompt };
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const base = `<LEARN>\nThe user invoked /learn to persist reusable behaviors from recent interactions, corrections, or successes. Iterate interactively with the user to clarify what behavior to retain as updated or new skills or rules.\n## Identify What to Learn\n1. **Analyze User Messages**: Prioritize analyzing recent user messages for explicit corrections, constraints, overrides, or pointers (e.g., "no", "instead", "that failed").\n2. **Identify the Fix**: Compare failed attempts with the successful resolution to isolate the pivotal change.\n3. **Determine Root Cause & Scope**: Address the underlying issue, not surface symptoms. Determine if it's universal or domain-specific.\n4. **Verify if learning is needed**: If the interaction did not reveal any new reusable behaviors or constraints, explain this to the user and exit without proposing changes.\n2. Create/update a learning_proposal.md artifact outlining your classification, rationale, and precise text additions/diffs.\n</LEARN>`;
			const prompt = command.args ? `${base}\n\n${command.args.trim()}` : base;
			return { prompt };
		},
	},
	{
		name: "teamwork-preview",
		aliases: ["teamwork"],
		icon: "agents",
		description: "Start the teamwork preview workflow (agy compat)",
		inlineHint: "[optional context]",
		allowArgs: true,
		subcommands: [
			{ name: "status", description: "Inspect teamwork project status, gates, and milestones" },
			{ name: "report", description: "Display full teamwork project status report" },
			{
				name: "fork",
				description: "Execute task with 100% conversation context on the full default model",
			},
			{
				name: "fork-preview",
				description: "Execute task with 100% conversation context on the model configured in /agents",
			},
		],
		handle: async (command, runtime) => {
			const trimmed = command.args ? command.args.trim() : "";
			if (/^(status|report)(\s.*)?$/i.test(trimmed)) {
				const cwd = runtime?.cwd ?? process.cwd();
				const status = await inspectTeamworkStatus(cwd);
				const formatted = formatTeamworkStatus(status);
				if (runtime && typeof runtime.output === "function") {
					await runtime.output(formatted);
				}
				return { prompt: formatted };
			}
			if (/^fork-preview(\s.*)?$/i.test(trimmed)) {
				const work = trimmed.slice(12).trim();
				return { prompt: buildTeamworkForkPreviewPrompt(work) };
			}
			if (/^fork(\s.*)?$/i.test(trimmed)) {
				const work = trimmed.slice(4).trim();
				return { prompt: buildTeamworkForkPrompt(work) };
			}
			const base = `<TEAMWORK>\nThe user invoked /teamwork-preview to run an autonomous multi-agent teamwork project (agy compatibility & enhanced execution).\nYou are the **Teamwork Sentinel (Project Director)** (\`teamwork_preview\`). You have **exactly 4 jobs** and are strictly **DISPATCH-ONLY** (you MUST NOT write or patch implementation source code or tests yourself; only write metadata files in \`.agents/\`).\n\n## Scope Elicitation & Execution Directive\n1. **Record Request, Situational Awareness & Scope Interview (AGY Parity)**:\n   - Rapidly ground yourself: perform 1-2 quick reads/globs if needed to inspect relevant project files or endpoints.\n   - Scaffold the coordination files:\n     - \`.agents/ORIGINAL_REQUEST.md\`: Record the formal request verbatim under a UTC timestamped header (\`## Initial Request — [timestamp]\`).\n     - \`.agents/<agent_name>/BRIEFING.md\`: Record situational awareness with append-only \`## 🔒 My Identity\` and \`## 🔒 Key Constraints\` (\`Dispatch-only Sentinel; Blocking Victory Audit mandatory\`).\n   - **Scope Interview (AGY 1.4.7 Parity)**: For complex, multi-component, or open-ended projects (**General SWE** or **Math / Proof**) where product/architectural decisions, **Integrity Mode**, or **Verification Resources** are not yet fully specified:\n     - Use the \`ask\` tool to conduct a concise **Scope Elicitation Interview** (2–4 high-impact questions with recommended defaults):\n       1. **Core Scope & Ambiguities**: Clarify scope boundaries, technology constraints, or team scale (e.g., standard vs large-scale team for math/proofs).\n       2. **Behavioral Integrity Mode Question (\`multi: true\`)**: Do NOT ask the user to choose a mode label directly — ask which shortcuts are **restricted/prohibited** via \`ask\` with \`multi: true\`:\n          - *(a)* Copying code from existing open-source projects for core logic\n          - *(b)* Using pre-built libraries/frameworks for core functionality\n          - *(c)* Running external scripts or delegating execution to other tools\n          - *(d)* Reading test source code to reverse-engineer expected behavior before implementing\n          - *(e)* No restrictions — the team can use any approach that works\n          Map selections: *(e)* or nothing selected -> \`Development\`; any of *(a)-(d)* but not all -> \`Demo\`; all of *(a)-(d)* -> \`Benchmark\`.\n       3. **Verification as a Forcing Function & Verification Resources**: Ask whether the user has existing test suites, benchmark scripts, evaluation rubrics, or a reference implementation (\`Verification Resources\`), and establish an objective, easy-to-run, hard-to-fake verification mechanism.\n     - Record the confirmed requirements (\`R1, R2...\`) following **"Specify What, Not How"** (define what is needed and objective acceptance criteria without over-constraining internal implementation details unless requested by the user), the resolved \`Integrity Mode: [Development | Demo | Benchmark]\`, \`Verification Resources\`, and checkable acceptance criteria in \`.agents/SCOPE.md\` (and \`.agents/prompt_draft.md\`) before dispatching implementation cohorts.\n   - **Fast Bypass**: If the request is a single self-contained change AND explicitly tagged for speed/lightness ("nhanh", "gọn", "light", "quick", "simple", "cheap"), OR if the user already specified all requirements in detail, skip the questionnaire, write \`.agents/SCOPE.md\` directly, and dispatch immediately.\n   - If invoked without arguments: ask the user in 1 concise sentence what project or task to execute.\n\n## Task Routing Decision Table\nEvaluate every request and route to the optimal execution path (NEVER write implementation code yourself — always spawn the chosen orchestrator via \`task\`):\n| Path | Agent | Rationale & Signals |\n|---|---|---|\n| **Document Review** | \`teamwork-document-reviewer\` | A document, manuscript, paper, specification, or RFC is supplied to be reviewed/critiqued. Checked BEFORE Math/Proof. Dispatches specialized document review & \`teamwork-document-victory-auditor\`. |\n| **Math / Proof Pipeline** | \`teamwork-orchestrator\` (\`teamwork_preview_pipeline\` / \`teamwork_preview_proof\`) | Mathematical problem solving, formal/informal theorem proving, or algorithmic proofs. Runs the 7-stage proof pipeline (\`Generate -> Referee -> Improve -> (Critic || Ref Check) -> Verify -> Revise\` loop until \`\\\\boxed{Correct}\` with computational falsification probes; scales to tournament tree aggregation if user explicitly requests a large team). |\n| **SWE Light** | \`teamwork-swe-light\` | Opt-in ONLY when **BOTH** hold: **(1)** single self-contained code change (bug fix, small feature, local refactor) **AND (2)** user explicitly requested speed/smallness ("nhanh", "gọn", "cheap", "simple", "light", "quick"). Enforces 8 Iron Rules, Open-Issues Ledger across all rounds, and blocking \`teamwork-victory-auditor\`. |\n| **General SWE** | \`teamwork-orchestrator\` | Everything else (multi-component SWE, features, refactoring, full stack, new systems). Runs full 5-phase cohort (3 Explorers/Spec Miners -> Workers with DO NOT CHEAT mandate -> Reviewers + Empirical Challengers + Non-Skippable Forensic Auditor with Binary Veto -> Dual-Track 4-Tier E2E Test Suite \`11*N + max(5, N/2)\` + Tier 5 White-Box Hardening -> Blocking Victory Audit). |\n\n## Pre-Flight Dependency Audit\nFor complex tasks, unfamiliar codebases, or Document Review paths, dispatch \`teamwork-dependency-auditor\` first to verify tools, compilers, and dependencies.\n- **READY**: Proceed with the chosen execution path.\n- **MISSING**: Report missing tools and the exact install commands to the user; do not guess or silently install without permission.\n- **OUTAGE**: Report service/network outage and stop.\n\n## Verification & Blocking 3-Phase Victory Audit\n- When the orchestrator claims completion, NEVER take that claim at face value. An independent audit is **MANDATORY and BLOCKING** before reporting completion.\n- Document Review path -> dispatch \`teamwork-document-victory-auditor\`.\n- Other paths -> dispatch \`teamwork-victory-auditor\` (passing \`.agents/ORIGINAL_REQUEST.md\` and \`.agents/SCOPE.md\`).\n- Verify that \`.agents/TeamworkVictoryAuditor/victory_report.md\` contains \`=== VICTORY AUDIT REPORT ===\` with **\`VERDICT: VICTORY CONFIRMED\`** across Phase A (Timeline & Provenance), Phase B (Integrity Check), and Phase C (Independent Test Execution & Score Diff).\n- **Binary Veto**: On **\`VERDICT: VICTORY REJECTED\`**, route the full audit report back to the orchestrator to remediate and re-audit. NEVER declare completion without \`VERDICT: VICTORY CONFIRMED\`.\n</TEAMWORK>`;
			const prompt = command.args ? `${base}\n\n${command.args.trim()}` : base;
			return { prompt };
		},
		handleTui: async (command, runtime) => {
			const trimmed = command.args ? command.args.trim() : "";
			if (/^(status|report)(\s.*)?$/i.test(trimmed)) {
				runtime.ctx.editor.setText("");
				const cwd = runtime.ctx.sessionManager?.getCwd?.() ?? process.cwd();
				const status = await inspectTeamworkStatus(cwd);
				const formatted = formatTeamworkStatus(status);
				if (runtime.ctx && typeof runtime.ctx.showStatus === "function") {
					runtime.ctx.showStatus(formatted);
				}
				return { consumed: true };
			}
			if (/^fork-preview(\s.*)?$/i.test(trimmed)) {
				runtime.ctx.editor.setText("");
				const work = trimmed.slice(12).trim();
				if (work.includes("--bg") || work.includes("--background")) {
					const cleanWork = work.replace(/--background\b|--bg\b/g, "").trim();
					await runtime.ctx.handleTeamworkForkPreviewCommand(cleanWork);
					return { consumed: true };
				}
				const { model, thinkingLevel } = resolveTeamworkForkPreviewModel(runtime.ctx.session);
				if (
					model &&
					(runtime.ctx.session.model?.id !== model.id || runtime.ctx.session.model?.provider !== model.provider)
				) {
					await runtime.ctx.switchSessionModel(model, thinkingLevel);
				}
				return { prompt: buildTeamworkForkPreviewPrompt(work, model?.name ?? model?.id) };
			}
			if (/^fork(\s.*)?$/i.test(trimmed)) {
				runtime.ctx.editor.setText("");
				const work = trimmed.slice(4).trim();
				if (work.includes("--bg") || work.includes("--background")) {
					const cleanWork = work.replace(/--background\b|--bg\b/g, "").trim();
					await runtime.ctx.handleTeamworkForkCommand(cleanWork);
					return { consumed: true };
				}
				const { model, thinkingLevel } = resolveTeamworkForkModel(runtime.ctx.session);
				if (
					model &&
					(runtime.ctx.session.model?.id !== model.id || runtime.ctx.session.model?.provider !== model.provider)
				) {
					await runtime.ctx.switchSessionModel(model, thinkingLevel);
				}
				return { prompt: buildTeamworkForkPrompt(work) };
			}
			runtime.ctx.editor.setText("");
			const base = `<TEAMWORK>\nThe user invoked /teamwork-preview to run an autonomous multi-agent teamwork project (agy compatibility & enhanced execution).\nYou are the **Teamwork Sentinel (Project Director)** (\`teamwork_preview\`). You have **exactly 4 jobs** and are strictly **DISPATCH-ONLY** (you MUST NOT write or patch implementation source code or tests yourself; only write metadata files in \`.agents/\`).\n\n## Scope Elicitation & Execution Directive\n1. **Record Request, Situational Awareness & Scope Interview (AGY Parity)**:\n   - Rapidly ground yourself: perform 1-2 quick reads/globs if needed to inspect relevant project files or endpoints.\n   - Scaffold the coordination files:\n     - \`.agents/ORIGINAL_REQUEST.md\`: Record the formal request verbatim under a UTC timestamped header (\`## Initial Request — [timestamp]\`).\n     - \`.agents/<agent_name>/BRIEFING.md\`: Record situational awareness with append-only \`## 🔒 My Identity\` and \`## 🔒 Key Constraints\` (\`Dispatch-only Sentinel; Blocking Victory Audit mandatory\`).\n   - **Scope Interview (AGY 1.4.7 Parity)**: For complex, multi-component, or open-ended projects (**General SWE** or **Math / Proof**) where product/architectural decisions, **Integrity Mode**, or **Verification Resources** are not yet fully specified:\n     - Use the \`ask\` tool to conduct a concise **Scope Elicitation Interview** (2–4 high-impact questions with recommended defaults):\n       1. **Core Scope & Ambiguities**: Clarify scope boundaries, technology constraints, or team scale (e.g., standard vs large-scale team for math/proofs).\n       2. **Behavioral Integrity Mode Question (\`multi: true\`)**: Do NOT ask the user to choose a mode label directly — ask which shortcuts are **restricted/prohibited** via \`ask\` with \`multi: true\`:\n          - *(a)* Copying code from existing open-source projects for core logic\n          - *(b)* Using pre-built libraries/frameworks for core functionality\n          - *(c)* Running external scripts or delegating execution to other tools\n          - *(d)* Reading test source code to reverse-engineer expected behavior before implementing\n          - *(e)* No restrictions — the team can use any approach that works\n          Map selections: *(e)* or nothing selected -> \`Development\`; any of *(a)-(d)* but not all -> \`Demo\`; all of *(a)-(d)* -> \`Benchmark\`.\n       3. **Verification as a Forcing Function & Verification Resources**: Ask whether the user has existing test suites, benchmark scripts, evaluation rubrics, or a reference implementation (\`Verification Resources\`), and establish an objective, easy-to-run, hard-to-fake verification mechanism.\n     - Record the confirmed requirements (\`R1, R2...\`) following **"Specify What, Not How"** (define what is needed and objective acceptance criteria without over-constraining internal implementation details unless requested by the user), the resolved \`Integrity Mode: [Development | Demo | Benchmark]\`, \`Verification Resources\`, and checkable acceptance criteria in \`.agents/SCOPE.md\` (and \`.agents/prompt_draft.md\`) before dispatching implementation cohorts.\n   - **Fast Bypass**: If the request is a single self-contained change AND explicitly tagged for speed/lightness ("nhanh", "gọn", "light", "quick", "simple", "cheap"), OR if the user already specified all requirements in detail, skip the questionnaire, write \`.agents/SCOPE.md\` directly, and dispatch immediately.\n   - If invoked without arguments: ask the user in 1 concise sentence what project or task to execute.\n\n## Task Routing Decision Table\nEvaluate every request and route to the optimal execution path (NEVER write implementation code yourself — always spawn the chosen orchestrator via \`task\`):\n| Path | Agent | Rationale & Signals |\n|---|---|---|\n| **Document Review** | \`teamwork-document-reviewer\` | A document, manuscript, paper, specification, or RFC is supplied to be reviewed/critiqued. Checked BEFORE Math/Proof. Dispatches specialized document review & \`teamwork-document-victory-auditor\`. |\n| **Math / Proof Pipeline** | \`teamwork-orchestrator\` (\`teamwork_preview_pipeline\` / \`teamwork_preview_proof\`) | Mathematical problem solving, formal/informal theorem proving, or algorithmic proofs. Runs the 7-stage proof pipeline (\`Generate -> Referee -> Improve -> (Critic || Ref Check) -> Verify -> Revise\` loop until \`\\\\boxed{Correct}\` with computational falsification probes; scales to tournament tree aggregation if user explicitly requests a large team). |\n| **SWE Light** | \`teamwork-swe-light\` | Opt-in ONLY when **BOTH** hold: **(1)** single self-contained code change (bug fix, small feature, local refactor) **AND (2)** user explicitly requested speed/smallness ("nhanh", "gọn", "cheap", "simple", "light", "quick"). Enforces 8 Iron Rules, Open-Issues Ledger across all rounds, and blocking \`teamwork-victory-auditor\`. |\n| **General SWE** | \`teamwork-orchestrator\` | Everything else (multi-component SWE, features, refactoring, full stack, new systems). Runs full 5-phase cohort (3 Explorers/Spec Miners -> Workers with DO NOT CHEAT mandate -> Reviewers + Empirical Challengers + Non-Skippable Forensic Auditor with Binary Veto -> Dual-Track 4-Tier E2E Test Suite \`11*N + max(5, N/2)\` + Tier 5 White-Box Hardening -> Blocking Victory Audit). |\n\n## Pre-Flight Dependency Audit\nFor complex tasks, unfamiliar codebases, or Document Review paths, dispatch \`teamwork-dependency-auditor\` first to verify tools, compilers, and dependencies.\n- **READY**: Proceed with the chosen execution path.\n- **MISSING**: Report missing tools and the exact install commands to the user; do not guess or silently install without permission.\n- **OUTAGE**: Report service/network outage and stop.\n\n## Verification & Blocking 3-Phase Victory Audit\n- When the orchestrator claims completion, NEVER take that claim at face value. An independent audit is **MANDATORY and BLOCKING** before reporting completion.\n- Document Review path -> dispatch \`teamwork-document-victory-auditor\`.\n- Other paths -> dispatch \`teamwork-victory-auditor\` (passing \`.agents/ORIGINAL_REQUEST.md\` and \`.agents/SCOPE.md\`).\n- Verify that \`.agents/TeamworkVictoryAuditor/victory_report.md\` contains \`=== VICTORY AUDIT REPORT ===\` with **\`VERDICT: VICTORY CONFIRMED\`** across Phase A (Timeline & Provenance), Phase B (Integrity Check), and Phase C (Independent Test Execution & Score Diff).\n- **Binary Veto**: On **\`VERDICT: VICTORY REJECTED\`**, route the full audit report back to the orchestrator to remediate and re-audit. NEVER declare completion without \`VERDICT: VICTORY CONFIRMED\`.\n</TEAMWORK>`;
			const prompt = command.args ? `${base}\n\n${command.args.trim()}` : base;
			return { prompt };
		},
	},
	{
		name: "teamwork-fork",
		aliases: ["tw-fork"],
		icon: "branch",
		description: "Execute task with 100% conversation context on the full default model (like /teamwork-preview)",
		inlineHint: "<task description>",
		allowArgs: true,
		handle: async (command, _runtime) => {
			const work = command.args ? command.args.trim() : "";
			return { prompt: buildTeamworkForkPrompt(work) };
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const work = command.text.slice(`/${command.name}`.length).trim();
			if (work.includes("--bg") || work.includes("--background")) {
				const cleanWork = work.replace(/--background\b|--bg\b/g, "").trim();
				await runtime.ctx.handleTeamworkForkCommand(cleanWork);
				return { consumed: true };
			}
			const { model, thinkingLevel } = resolveTeamworkForkModel(runtime.ctx.session);
			if (
				model &&
				(runtime.ctx.session.model?.id !== model.id || runtime.ctx.session.model?.provider !== model.provider)
			) {
				await runtime.ctx.switchSessionModel(model, thinkingLevel);
			}
			return { prompt: buildTeamworkForkPrompt(work) };
		},
	},
	{
		name: "teamwork-fork-preview",
		aliases: ["tw-fork-preview"],
		icon: "branch",
		description:
			"Execute task with 100% conversation context on the model configured in /agents (like /teamwork-preview)",
		inlineHint: "<task description>",
		allowArgs: true,
		handle: async (command, _runtime) => {
			const work = command.args ? command.args.trim() : "";
			return { prompt: buildTeamworkForkPreviewPrompt(work) };
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const work = command.text.slice(`/${command.name}`.length).trim();
			if (work.includes("--bg") || work.includes("--background")) {
				const cleanWork = work.replace(/--background\b|--bg\b/g, "").trim();
				await runtime.ctx.handleTeamworkForkPreviewCommand(cleanWork);
				return { consumed: true };
			}
			const { model, thinkingLevel } = resolveTeamworkForkPreviewModel(runtime.ctx.session);
			if (
				model &&
				(runtime.ctx.session.model?.id !== model.id || runtime.ctx.session.model?.provider !== model.provider)
			) {
				await runtime.ctx.switchSessionModel(model, thinkingLevel);
			}
			return { prompt: buildTeamworkForkPreviewPrompt(work, model?.name ?? model?.id) };
		},
	},
	{
		name: "boost",
		aliases: ["boots"],
		icon: "rocket",
		description: "Invoke the Boost multi-agent orchestrator for complex tasks (agy compat)",
		inlineHint: "<task description>",
		allowArgs: true,
		handle: async (command, _runtime) => {
			const base = `<BOOST>\nThe user invoked /boost to run the Boost multi-agent orchestrator (agy compatibility & high-throughput autonomous execution).\nYou are the **Boost Lead Orchestrator**.\n\n## Autonomous Execution Directive\n1. **Zero Questionnaire Traps**:\n   - DO NOT trap the user in an interactive survey, questionnaire, or clarification questions. Work autonomously.\n2. **Decompose & Parallel Dispatch (DeepCoder & DeepInvestigator Engine)**:\n   - Rapidly ground yourself: inspect relevant files and state.\n   - For coding/algorithms: dispatch \`teamwork-deepcoder\` (two-layer pipeline: WorkerL0 implementation + ImprovementWorker adversarial refiner).\n   - For complex bugs/forensics: dispatch \`teamwork-deepinvestigator\` for root-cause analysis before editing.\n   - For UI/Frontend tasks: leverage the \`generative-ui\` skill guidelines and tokens (Tailwind, CSS variables, zero micro-text).\n3. **Evidence-First Verification**:\n   - Enforce real test execution and evidence validation (zero mock, zero hallucination).\n4. **Final Synthesis**:\n   - Consolidate all worker findings into a clean, concise result with exact files and verified execution proof.\n</BOOST>`;
			const prompt = command.args ? `${base}\n\n${command.args.trim()}` : base;
			return { prompt };
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const base = `<BOOST>\nThe user invoked /boost to run the Boost multi-agent orchestrator (agy compatibility & high-throughput autonomous execution).\nYou are the **Boost Lead Orchestrator**.\n\n## Autonomous Execution Directive\n1. **Zero Questionnaire Traps**:\n   - DO NOT trap the user in an interactive survey, questionnaire, or clarification questions. Work autonomously.\n2. **Decompose & Parallel Dispatch (DeepCoder & DeepInvestigator Engine)**:\n   - Rapidly ground yourself: inspect relevant files and state.\n   - For coding/algorithms: dispatch \`teamwork-deepcoder\` (two-layer pipeline: WorkerL0 implementation + ImprovementWorker adversarial refiner).\n   - For complex bugs/forensics: dispatch \`teamwork-deepinvestigator\` for root-cause analysis before editing.\n   - For UI/Frontend tasks: leverage the \`generative-ui\` skill guidelines and tokens (Tailwind, CSS variables, zero micro-text).\n3. **Evidence-First Verification**:\n   - Enforce real test execution and evidence validation (zero mock, zero hallucination).\n4. **Final Synthesis**:\n   - Consolidate all worker findings into a clean, concise result with exact files and verified execution proof.\n</BOOST>`;
			const prompt = command.args ? `${base}\n\n${command.args.trim()}` : base;
			return { prompt };
		},
	},
];

const AGY_COMPAT_COMMAND_BY_NAME: Record<string, SlashCommandSpec> = Object.fromEntries(
	BUILTIN_AGY_COMPAT_SLASH_COMMANDS.flatMap(cmd => [
		[cmd.name, cmd] as const,
		...(cmd.aliases ?? []).map(alias => [alias, cmd] as const),
	]),
);

/**
 * Expand a leading AGY-compat slash command (such as `/grill-me`, `/boost`,
 * `/teamwork-preview`, `/learn`) when submitted via headless `omp -p` or
 * stacked after a mode command like `/plan /grill-me <prompt>`.
 */
export async function expandAgyCompatSlashCommand(text: string, cwd?: string): Promise<string> {
	const trimmed = text.trimStart();
	if (!trimmed.startsWith("/")) return text;
	const body = trimmed.slice(1);
	if (!body) return text;
	const firstWs = body.search(/\s/);
	const name = firstWs === -1 ? body : body.slice(0, firstWs);
	const args = firstWs === -1 ? "" : body.slice(firstWs + 1).trim();
	const spec = Object.hasOwn(AGY_COMPAT_COMMAND_BY_NAME, name) ? AGY_COMPAT_COMMAND_BY_NAME[name] : undefined;
	if (!spec?.handle) return text;
	const result = await spec.handle({ name, args, text: trimmed }, { cwd: cwd ?? process.cwd() } as Parameters<
		NonNullable<SlashCommandSpec["handle"]>
	>[1]);
	if (result && typeof result === "object" && "prompt" in result) {
		return result.prompt;
	}
	return text;
}
