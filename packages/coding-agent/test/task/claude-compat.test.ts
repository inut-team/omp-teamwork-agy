import { describe, expect, it } from "bun:test";
import { loadBundledAgents } from "@oh-my-pi/pi-coding-agent/task/agents";
import { getAgent } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { BUILTIN_CLAUDE_COMPAT_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-claude-compat";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

describe("Claude Code Compatibility: Agents & Slash Commands", () => {
	it("bundles ship-audit agent definition", () => {
		const agents = loadBundledAgents();
		const shipAudit = agents.find(a => a.name === "ship-audit");
		expect(shipAudit).toBeDefined();
		expect(shipAudit?.description).toContain("pre-ship audit");
		expect(shipAudit?.tools).toContain("read");
		expect(shipAudit?.tools).toContain("bash");
	});

	it("resolves Claude Code subagent aliases", () => {
		const agents = loadBundledAgents();

		// ship-audit aliases
		expect(getAgent(agents, "ship-audit")?.name).toBe("ship-audit");
		expect(getAgent(agents, "claude-ship-audit")?.name).toBe("ship-audit");
		expect(getAgent(agents, "ship")?.name).toBe("ship-audit");

		// Claude archetype aliases mapped to OMP equivalents
		expect(getAgent(agents, "code-reviewer")?.name).toBe("teamwork-reviewer");
		expect(getAgent(agents, "general-purpose")?.name).toBe("task");
		expect(getAgent(agents, "software-architect")?.name).toBe("teamwork-orchestrator");
	});

	it("provides /claude slash command with workflow directives and subcommands", async () => {
		const cmd = BUILTIN_CLAUDE_COMPAT_SLASH_COMMANDS.find(c => c.name === "claude");
		expect(cmd).toBeDefined();
		expect(cmd?.aliases).toContain("ultrareview");
		expect(cmd?.aliases).toContain("claude-review");

		if (!cmd || !cmd.handle) throw new Error("Command handle not found");

		const result = await cmd.handle(
			{ name: "claude", args: "review src/api.ts", text: "claude review src/api.ts" },
			{} as unknown as SlashCommandRuntime,
		);
		expect(result).toBeDefined();
		if (result && "prompt" in result) {
			expect(result.prompt).toContain("<CLAUDE_WORKFLOW>");
			expect(result.prompt).toContain("Subagent Delegation Architecture");
			expect(result.prompt).toContain("ReportFindings");
			expect(result.prompt).toContain("review src/api.ts");
		} else {
			throw new Error("Expected prompt result");
		}
	});

	it("provides /ship-audit slash command with pre-ship verification directives", async () => {
		const cmd = BUILTIN_CLAUDE_COMPAT_SLASH_COMMANDS.find(c => c.name === "ship-audit");
		expect(cmd).toBeDefined();
		expect(cmd?.aliases).toContain("ship");

		if (!cmd || !cmd.handle) throw new Error("Command handle not found");

		const result = await cmd.handle(
			{ name: "ship-audit", args: "focus on CI and migrations", text: "ship-audit focus on CI and migrations" },
			{} as unknown as SlashCommandRuntime,
		);
		expect(result).toBeDefined();
		if (result && "prompt" in result) {
			expect(result.prompt).toContain("<SHIP_AUDIT>");
			expect(result.prompt).toContain("Dispatch Ship Auditor");
			expect(result.prompt).toContain("focus on CI and migrations");
		} else {
			throw new Error("Expected prompt result");
		}
	});

	it("provides /skill-doctor slash command to audit context token consumption", async () => {
		const cmd = BUILTIN_CLAUDE_COMPAT_SLASH_COMMANDS.find(c => c.name === "skill-doctor");
		expect(cmd).toBeDefined();

		if (!cmd || !cmd.handle) throw new Error("Command handle not found");

		const result = await cmd.handle(
			{ name: "skill-doctor", args: "", text: "skill-doctor" },
			{} as unknown as SlashCommandRuntime,
		);
		expect(result).toBeDefined();
		if (result && "prompt" in result) {
			expect(result.prompt).toContain("<SKILL_DOCTOR>");
			expect(result.prompt).toContain("Enumerate Active Skills");
			expect(result.prompt).toContain("Context Impact Analysis");
		} else {
			throw new Error("Expected prompt result");
		}
	});
});
