import type { SlashCommandSpec } from "./types";
import { formatTeamworkStatus, inspectTeamworkStatus } from "../task/teamwork-status";
import {
	buildTeamworkForkPreviewPrompt,
	buildTeamworkForkPrompt,
	resolveTeamworkForkModel,
	resolveTeamworkForkPreviewModel,
} from "../task/teamwork-fork-model";
export const BUILTIN_AGY_COMPAT_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
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
			const base = `<TEAMWORK>\nThe user invoked /teamwork-preview to run an autonomous multi-agent teamwork project (agy compatibility & enhanced execution).\nYou are the **Teamwork Sentinel (Project Director)**.\n\n## Autonomous Execution Directive\n1. **Zero Questionnaire Traps**:\n   - DO NOT trap the user in an interactive 9-step survey or ask unnecessary questions.\n   - If a request/task is provided with the command:\n     - Rapidly ground yourself: perform 1-2 quick reads/globs if needed to inspect relevant project files or endpoints.\n     - Scaffold the coordination files:\n       - \`.agents/ORIGINAL_REQUEST.md\`: Record the formal request verbatim under a timestamped header.\n       - \`.agents/<agent_name>/BRIEFING.md\`: Record situational awareness with append-only \`## 🔒 My Identity\` and \`## 🔒 Key Constraints\` sections.\n     - Evaluate the task against the **Routing Decision Table** and immediately dispatch the chosen path.\n   - If invoked without arguments: ask the user in 1 concise sentence what project or task to execute.\n\n## Task Routing Decision Table\nEvaluate every request and route to the optimal execution path:\n| Path | Agent | Rationale & Signals |\n|---|---|---|\n| **SWE Light** | \`teamwork-swe-light\` | Single self-contained code change (bug fix, small feature, local refactor) OR user explicitly requested speed/smallness ("nhanh", "gọn", "cheap", "simple"). Runs collapsed team: 1 implementer + reviewer loop. |\n| **Document Review** | \`teamwork-document-reviewer\` | A document, manuscript, paper, specification, or RFC is supplied to be reviewed/critiqued. Dispatches specialized document review & \`teamwork-document-victory-auditor\`. |\n| **General SWE** | \`teamwork-orchestrator\` | Multi-component software engineering, large refactoring, full stack, or new systems. Runs full 5-phase cohort with Dual-Track test execution. |\n\n## Pre-Flight Dependency Audit\nFor complex tasks or unfamiliar codebases, dispatch \`teamwork-dependency-auditor\` first to verify tools, compilers, and dependencies.\n- **READY**: Proceed with the chosen execution path.\n- **MISSING**: Report missing tools and the exact install commands to the user; do not guess or silently install without permission.\n- **OUTAGE**: Report service/network outage and stop.\n\n## Verification & Victory Audit\n- An independent audit is MANDATORY before reporting completion.\n- Document Review path -> dispatch \`teamwork-document-victory-auditor\`.\n- Other paths -> dispatch \`teamwork-victory-auditor\`.\n- Binary Veto: On VICTORY REJECTED, route the audit report back to the team. NEVER declare completion without VICTORY CONFIRMED.\n</TEAMWORK>`;
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
			const base = `<TEAMWORK>\nThe user invoked /teamwork-preview to run an autonomous multi-agent teamwork project (agy compatibility & enhanced execution).\nYou are the **Teamwork Sentinel (Project Director)**.\n\n## Autonomous Execution Directive\n1. **Zero Questionnaire Traps**:\n   - DO NOT trap the user in an interactive 9-step survey or ask unnecessary questions.\n   - If a request/task is provided with the command:\n     - Rapidly ground yourself: perform 1-2 quick reads/globs if needed to inspect relevant project files or endpoints.\n     - Scaffold the coordination files:\n       - \`.agents/ORIGINAL_REQUEST.md\`: Record the formal request verbatim under a timestamped header.\n       - \`.agents/<agent_name>/BRIEFING.md\`: Record situational awareness with append-only \`## 🔒 My Identity\` and \`## 🔒 Key Constraints\` sections.\n     - Evaluate the task against the **Routing Decision Table** and immediately dispatch the chosen path.\n   - If invoked without arguments: ask the user in 1 concise sentence what project or task to execute.\n\n## Task Routing Decision Table\nEvaluate every request and route to the optimal execution path:\n| Path | Agent | Rationale & Signals |\n|---|---|---|\n| **SWE Light** | \`teamwork-swe-light\` | Single self-contained code change (bug fix, small feature, local refactor) OR user explicitly requested speed/smallness ("nhanh", "gọn", "cheap", "simple"). Runs collapsed team: 1 implementer + reviewer loop. |\n| **Document Review** | \`teamwork-document-reviewer\` | A document, manuscript, paper, specification, or RFC is supplied to be reviewed/critiqued. Dispatches specialized document review & \`teamwork-document-victory-auditor\`. |\n| **General SWE** | \`teamwork-orchestrator\` | Multi-component software engineering, large refactoring, full stack, or new systems. Runs full 5-phase cohort with Dual-Track test execution. |\n\n## Pre-Flight Dependency Audit\nFor complex tasks or unfamiliar codebases, dispatch \`teamwork-dependency-auditor\` first to verify tools, compilers, and dependencies.\n- **READY**: Proceed with the chosen execution path.\n- **MISSING**: Report missing tools and the exact install commands to the user; do not guess or silently install without permission.\n- **OUTAGE**: Report service/network outage and stop.\n\n## Verification & Victory Audit\n- An independent audit is MANDATORY before reporting completion.\n- Document Review path -> dispatch \`teamwork-document-victory-auditor\`.\n- Other paths -> dispatch \`teamwork-victory-auditor\`.\n- Binary Veto: On VICTORY REJECTED, route the audit report back to the team. NEVER declare completion without VICTORY CONFIRMED.\n</TEAMWORK>`;
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
