import { describe, expect, it } from "bun:test";
import { loadBundledAgents } from "@oh-my-pi/pi-coding-agent/task/agents";
import { getAgent } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { BUILTIN_AGY_COMPAT_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-agy-compat";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

describe("Teamwork Agents & Slash Command Integration", () => {
	it("bundles all 12 teamwork agent definitions", () => {
		const agents = loadBundledAgents();
		const agentNames = agents.map(a => a.name);

		// Core SWE Agents
		expect(agentNames).toContain("teamwork-orchestrator");
		expect(agentNames).toContain("teamwork-explorer");
		expect(agentNames).toContain("teamwork-worker");
		expect(agentNames).toContain("teamwork-reviewer");
		expect(agentNames).toContain("teamwork-challenger");
		expect(agentNames).toContain("teamwork-auditor");
		expect(agentNames).toContain("teamwork-victory-auditor");

		// Advanced Specialized Agents (AGY Parity)
		expect(agentNames).toContain("teamwork-swe-light");
		expect(agentNames).toContain("teamwork-implementer");
		expect(agentNames).toContain("teamwork-dependency-auditor");
		expect(agentNames).toContain("teamwork-document-reviewer");
		expect(agentNames).toContain("teamwork-document-victory-auditor");
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

		// SWE Light aliases
		expect(getAgent(agents, "teamwork-swe-light")?.name).toBe("teamwork-swe-light");
		expect(getAgent(agents, "teamwork_preview_swe")?.name).toBe("teamwork-swe-light");
		expect(getAgent(agents, "teamwork-preview-swe")?.name).toBe("teamwork-swe-light");
		expect(getAgent(agents, "swe-light")?.name).toBe("teamwork-swe-light");
		expect(getAgent(agents, "swe")?.name).toBe("teamwork-swe-light");

		// Implementer aliases
		expect(getAgent(agents, "teamwork-implementer")?.name).toBe("teamwork-implementer");
		expect(getAgent(agents, "teamwork_preview_implementer")?.name).toBe("teamwork-implementer");
		expect(getAgent(agents, "implementer")?.name).toBe("teamwork-implementer");

		// Worker aliases
		expect(getAgent(agents, "teamwork-worker")?.name).toBe("teamwork-worker");
		expect(getAgent(agents, "teamwork_preview_worker")?.name).toBe("teamwork-worker");
		expect(getAgent(agents, "worker")?.name).toBe("teamwork-worker");

		// Explorer aliases
		expect(getAgent(agents, "teamwork-explorer")?.name).toBe("teamwork-explorer");
		expect(getAgent(agents, "teamwork_preview_explorer")?.name).toBe("teamwork-explorer");
		expect(getAgent(agents, "explorer")?.name).toBe("teamwork-explorer");

		// Reviewer aliases
		expect(getAgent(agents, "teamwork-reviewer")?.name).toBe("teamwork-reviewer");
		expect(getAgent(agents, "teamwork_preview_reviewer")?.name).toBe("teamwork-reviewer");

		// Challenger aliases
		expect(getAgent(agents, "teamwork-challenger")?.name).toBe("teamwork-challenger");
		expect(getAgent(agents, "teamwork_preview_challenger")?.name).toBe("teamwork-challenger");
		expect(getAgent(agents, "challenger")?.name).toBe("teamwork-challenger");

		// Dependency Auditor aliases
		expect(getAgent(agents, "teamwork-dependency-auditor")?.name).toBe("teamwork-dependency-auditor");
		expect(getAgent(agents, "teamwork_preview_dependency")?.name).toBe("teamwork-dependency-auditor");
		expect(getAgent(agents, "dependency-auditor")?.name).toBe("teamwork-dependency-auditor");
		expect(getAgent(agents, "dependency")?.name).toBe("teamwork-dependency-auditor");

		// Document Reviewer aliases
		expect(getAgent(agents, "teamwork-document-reviewer")?.name).toBe("teamwork-document-reviewer");
		expect(getAgent(agents, "teamwork_preview_document")?.name).toBe("teamwork-document-reviewer");
		expect(getAgent(agents, "document-reviewer")?.name).toBe("teamwork-document-reviewer");
		expect(getAgent(agents, "document")?.name).toBe("teamwork-document-reviewer");

		// Document Victory Auditor aliases
		expect(getAgent(agents, "teamwork-document-victory-auditor")?.name).toBe("teamwork-document-victory-auditor");
		expect(getAgent(agents, "teamwork_preview_document_victory_auditor")?.name).toBe(
			"teamwork-document-victory-auditor",
		);
		expect(getAgent(agents, "document-victory-auditor")?.name).toBe("teamwork-document-victory-auditor");

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

	it("teamwork orchestrators have unrestricted spawn permissions (*)", () => {
		const agents = loadBundledAgents();
		const orchestrator = getAgent(agents, "teamwork-orchestrator");
		expect(orchestrator).toBeDefined();
		expect(orchestrator?.spawns).toBe("*");
		expect(orchestrator?.tools).toContain("task");
		expect(orchestrator?.tools).toContain("hub");

		const sweLight = getAgent(agents, "teamwork-swe-light");
		expect(sweLight).toBeDefined();
		expect(sweLight?.spawns).toBe("*");
		expect(sweLight?.tools).toContain("task");
	});

	it("provides /teamwork-preview and /teamwork slash commands with Routing Decision Table", async () => {
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
			expect(result.prompt).toContain("Routing Decision Table");
			expect(result.prompt).toContain("SWE Light");
			expect(result.prompt).toContain("Pre-Flight Dependency Audit");
			expect(result.prompt).toContain("xây dựng search engine");
		} else {
			throw new Error("Expected prompt result");
		}
	});
});
