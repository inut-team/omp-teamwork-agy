import { prompt } from "@oh-my-pi/pi-utils";
import claudeWorkflowPrompt from "../prompts/slash-commands/claude-workflow.md" with { type: "text" };
import shipAuditPrompt from "../prompts/slash-commands/ship-audit-cmd.md" with { type: "text" };
import skillDoctorPrompt from "../prompts/slash-commands/skill-doctor.md" with { type: "text" };
import type { SlashCommandSpec } from "./types";

export const BUILTIN_CLAUDE_COMPAT_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "claude",
		aliases: ["claude-code", "ultrareview", "claude-review"],
		icon: "agents",
		description: "Run Claude Code workflows: multi-agent review, ship-readiness audit, and subagent delegation",
		inlineHint: "[review | audit | doctor | optional prompt]",
		allowArgs: true,
		handle: async (command, _runtime) => {
			const text = prompt.render(claudeWorkflowPrompt, { arguments: command.args?.trim() });
			return { prompt: text };
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const text = prompt.render(claudeWorkflowPrompt, { arguments: command.args?.trim() });
			return { prompt: text };
		},
	},
	{
		name: "ship-audit",
		aliases: ["ship"],
		icon: "rocket",
		description: "Run a branch ship-readiness audit checking uncommitted files, commits ahead, tests, and CI",
		inlineHint: "[optional focus/notes]",
		allowArgs: true,
		handle: async (command, _runtime) => {
			const text = prompt.render(shipAuditPrompt, { arguments: command.args?.trim() });
			return { prompt: text };
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const text = prompt.render(shipAuditPrompt, { arguments: command.args?.trim() });
			return { prompt: text };
		},
	},
	{
		name: "skill-doctor",
		icon: "stethoscope",
		description: "Inspect active skills, calculate context token consumption, and detect unused skills",
		inlineHint: "[optional filter]",
		allowArgs: true,
		handle: async (command, _runtime) => {
			const text = prompt.render(skillDoctorPrompt, { arguments: command.args?.trim() });
			return { prompt: text };
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const text = prompt.render(skillDoctorPrompt, { arguments: command.args?.trim() });
			return { prompt: text };
		},
	},
];
