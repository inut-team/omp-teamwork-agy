import { describe, expect, it } from "bun:test";
import { loadBundledAgents } from "@oh-my-pi/pi-coding-agent/task/agents";
import { getAgent } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { BUILTIN_AGY_COMPAT_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-agy-compat";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

describe("Teamwork Agents & Slash Command Integration", () => {
	it("bundles all 7 teamwork agent definitions", () => {
		const agents = loadBundledAgents();
		const agentNames = agents.map(a => a.name);

		expect(agentNames).toContain("teamwork-orchestrator");
		expect(agentNames).toContain("teamwork-explorer");
		expect(agentNames).toContain("teamwork-worker");
		expect(agentNames).toContain("teamwork-reviewer");
		expect(agentNames).toContain("teamwork-challenger");
		expect(agentNames).toContain("teamwork-auditor");
		expect(agentNames).toContain("teamwork-victory-auditor");
	});

	it("resolves teamwork agent aliases correctly", () => {
		const agents = loadBundledAgents();

		// Orchestrator aliases
		expect(getAgent(agents, "teamwork")?.name).toBe("teamwork-orchestrator");
		expect(getAgent(agents, "teamwork-preview")?.name).toBe("teamwork-orchestrator");
		expect(getAgent(agents, "teamwork_preview")?.name).toBe("teamwork-orchestrator");
		expect(getAgent(agents, "teamwork_preview_orchestrator")?.name).toBe("teamwork-orchestrator");
		expect(getAgent(agents, "teamwork-orchestrator")?.name).toBe("teamwork-orchestrator");
		expect(getAgent(agents, "orchestrator")?.name).toBe("teamwork-orchestrator");

		// Explorer aliases
		expect(getAgent(agents, "teamwork-explorer")?.name).toBe("teamwork-explorer");
		expect(getAgent(agents, "teamwork_preview_explorer")?.name).toBe("teamwork-explorer");
		expect(getAgent(agents, "explorer")?.name).toBe("teamwork-explorer");

		// Worker aliases
		expect(getAgent(agents, "teamwork-worker")?.name).toBe("teamwork-worker");
		expect(getAgent(agents, "teamwork_preview_worker")?.name).toBe("teamwork-worker");
		expect(getAgent(agents, "teamwork-implementer")?.name).toBe("teamwork-worker");
		expect(getAgent(agents, "teamwork_preview_implementer")?.name).toBe("teamwork-worker");
		expect(getAgent(agents, "worker")?.name).toBe("teamwork-worker");
		expect(getAgent(agents, "implementer")?.name).toBe("teamwork-worker");

		// Reviewer aliases
		expect(getAgent(agents, "teamwork-reviewer")?.name).toBe("teamwork-reviewer");
		expect(getAgent(agents, "teamwork_preview_reviewer")?.name).toBe("teamwork-reviewer");

		// Challenger aliases
		expect(getAgent(agents, "teamwork-challenger")?.name).toBe("teamwork-challenger");
		expect(getAgent(agents, "teamwork_preview_challenger")?.name).toBe("teamwork-challenger");
		expect(getAgent(agents, "challenger")?.name).toBe("teamwork-challenger");

		// Auditor aliases
		expect(getAgent(agents, "teamwork-auditor")?.name).toBe("teamwork-auditor");
		expect(getAgent(agents, "teamwork_preview_auditor")?.name).toBe("teamwork-auditor");
		expect(getAgent(agents, "teamwork_preview_forensic_auditor")?.name).toBe("teamwork-auditor");
		expect(getAgent(agents, "forensic-auditor")?.name).toBe("teamwork-auditor");
		expect(getAgent(agents, "auditor")?.name).toBe("teamwork-auditor");

		// Victory Auditor aliases
		expect(getAgent(agents, "teamwork-victory-auditor")?.name).toBe("teamwork-victory-auditor");
		expect(getAgent(agents, "teamwork_preview_victory_auditor")?.name).toBe("teamwork-victory-auditor");
		expect(getAgent(agents, "victory-auditor")?.name).toBe("teamwork-victory-auditor");
	});

	it("teamwork-orchestrator has unrestricted spawn permissions (*)", () => {
		const agents = loadBundledAgents();
		const orchestrator = getAgent(agents, "teamwork-orchestrator");
		expect(orchestrator).toBeDefined();
		expect(orchestrator?.spawns).toBe("*");
		expect(orchestrator?.tools).toContain("task");
		expect(orchestrator?.tools).toContain("hub");
	});

	it("provides /teamwork-preview and /teamwork slash commands with autonomous directive", async () => {
		const cmd = BUILTIN_AGY_COMPAT_SLASH_COMMANDS.find(c => c.name === "teamwork-preview");
		expect(cmd).toBeDefined();
		expect(cmd?.aliases).toContain("teamwork");

		if (!cmd || !cmd.handle) {
			throw new Error("teamwork-preview command or handle not found");
		}
		const result = await cmd.handle(
			{ name: "teamwork-preview", args: "xây dựng search engine", text: "teamwork-preview xây dựng search engine" },
			{} as unknown as SlashCommandRuntime,
		);
		expect(result).toBeDefined();
		if (result && "prompt" in result) {
			expect(result.prompt).toContain("<TEAMWORK>");
			expect(result.prompt).toContain("Zero Questionnaire Traps");
			expect(result.prompt).toContain("teamwork-orchestrator");
			expect(result.prompt).toContain("xây dựng search engine");
		} else {
			throw new Error("Expected prompt result");
		}
	});
});
