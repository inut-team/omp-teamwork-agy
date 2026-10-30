import { describe, expect, it } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadBundledAgents } from "@oh-my-pi/pi-coding-agent/task/agents";
import { getAgent } from "@oh-my-pi/pi-coding-agent/task/discovery";
import {
	BUILTIN_AGY_COMPAT_SLASH_COMMANDS,
	expandAgyCompatSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-agy-compat";
import {
	buildTeamworkForkPreviewPrompt,
	buildTeamworkForkPrompt,
	buildUltraPreviewPrompt,
	resolveUltraPreviewModel,
} from "@oh-my-pi/pi-coding-agent/task/teamwork-fork-model";
import { formatTeamworkStatus, inspectTeamworkStatus } from "@oh-my-pi/pi-coding-agent/task/teamwork-status";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
describe("Teamwork Agents & Slash Command Integration", () => {
	it("bundles all 14 teamwork agent definitions (including DeepCoder & DeepInvestigator)", () => {
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

		// DeepMind & Dual-Track Parity Agents (including AGY 1.4.9 Interviewer, Surgical Reviser & Knowledge Curator)
		expect(agentNames).toContain("teamwork-deepcoder");
		expect(agentNames).toContain("teamwork-deepinvestigator");
		expect(agentNames).toContain("teamwork-test-writer");
		expect(agentNames).toContain("teamwork-spec-miner");
		expect(agentNames).toContain("teamwork-interviewer");
		expect(agentNames).toContain("teamwork-surgical-reviser");
		expect(agentNames).toContain("teamwork-knowledge-curator");
		expect(agentNames).toContain("teamwork-awaiter");
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

		// DeepMind Parity aliases
		expect(getAgent(agents, "deepcoder")?.name).toBe("teamwork-deepcoder");
		expect(getAgent(agents, "deep-coder")?.name).toBe("teamwork-deepcoder");
		expect(getAgent(agents, "deepinvestigator")?.name).toBe("teamwork-deepinvestigator");
		expect(getAgent(agents, "deep-investigator")?.name).toBe("teamwork-deepinvestigator");

		// Test Writer & Spec Miner aliases (AGY Dual-Track & Phase 0 Survey parity)
		expect(getAgent(agents, "teamwork-test-writer")?.name).toBe("teamwork-test-writer");
		expect(getAgent(agents, "teamwork_preview_test_writer")?.name).toBe("teamwork-test-writer");
		expect(getAgent(agents, "test-writer")?.name).toBe("teamwork-test-writer");
		expect(getAgent(agents, "e2e-test-writer")?.name).toBe("teamwork-test-writer");
		expect(getAgent(agents, "teamwork-spec-miner")?.name).toBe("teamwork-spec-miner");
		expect(getAgent(agents, "teamwork_preview_spec_miner")?.name).toBe("teamwork-spec-miner");
		expect(getAgent(agents, "spec-miner")?.name).toBe("teamwork-spec-miner");
		expect(getAgent(agents, "specification-miner")?.name).toBe("teamwork-spec-miner");
		expect(getAgent(agents, "teamwork_preview_pipeline")?.name).toBe("teamwork-orchestrator");
		expect(getAgent(agents, "teamwork_preview_conductor")?.name).toBe("teamwork-orchestrator");
		expect(getAgent(agents, "teamwork_preview_proof")?.name).toBe("teamwork-orchestrator");
		expect(getAgent(agents, "teamwork_pipeline")?.name).toBe("teamwork-orchestrator");
		expect(getAgent(agents, "teamwork_proof")?.name).toBe("teamwork-orchestrator");
		expect(getAgent(agents, "swarm_orchestrator")?.name).toBe("teamwork-orchestrator");
		expect(getAgent(agents, "stellar_orchestrator")?.name).toBe("teamwork-orchestrator");

		// AGY 1.4.9 Interviewer, Surgical Reviser & Knowledge Curator aliases
		expect(getAgent(agents, "teamwork-interviewer")?.name).toBe("teamwork-interviewer");
		expect(getAgent(agents, "teamwork_interviewer")?.name).toBe("teamwork-interviewer");
		expect(getAgent(agents, "interviewer")?.name).toBe("teamwork-interviewer");
		expect(getAgent(agents, "teamwork-surgical-reviser")?.name).toBe("teamwork-surgical-reviser");
		expect(getAgent(agents, "surgical_reviser")?.name).toBe("teamwork-surgical-reviser");
		expect(getAgent(agents, "teamwork_patcher")?.name).toBe("teamwork-surgical-reviser");
		expect(getAgent(agents, "patcher")?.name).toBe("teamwork-surgical-reviser");
		expect(getAgent(agents, "teamwork-knowledge-curator")?.name).toBe("teamwork-knowledge-curator");
		expect(getAgent(agents, "knowledge_curator")?.name).toBe("teamwork-knowledge-curator");
		expect(getAgent(agents, "teamwork_curator")?.name).toBe("teamwork-knowledge-curator");
		expect(getAgent(agents, "curator")?.name).toBe("teamwork-knowledge-curator");
		expect(getAgent(agents, "teamwork-awaiter")?.name).toBe("teamwork-awaiter");
		expect(getAgent(agents, "teamwork_awaiter")?.name).toBe("teamwork-awaiter");
		expect(getAgent(agents, "awaiter")?.name).toBe("teamwork-awaiter");
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
			expect(result.prompt).toContain("DISPATCH-ONLY");
			expect(result.prompt).toContain("[skip-interview]");
			expect(result.prompt).toContain("teamwork-interviewer");
			expect(result.prompt).toContain("BEGIN PROMPT");
			expect(result.prompt).toContain("END PROMPT");
			expect(result.prompt).toContain("Behavioral Integrity Mode Question");
			expect(result.prompt).toContain("Specify What, Not How");
			expect(result.prompt).toContain("Verification as a Forcing Function & Verification Resources");
			expect(result.prompt).toContain(".agents/SCOPE.md");
			expect(result.prompt).toContain(".agents/prompt_draft.md");
			expect(result.prompt).toContain("Routing Decision Table");
			expect(result.prompt).toContain("Math / Proof (Large Team)");
			expect(result.prompt).toContain("Math / Proof Pipeline");
			expect(result.prompt).toContain("SWE Light");
			expect(result.prompt).toContain("=== VICTORY AUDIT REPORT ===");
			expect(result.prompt).toContain("xây dựng search engine");
		} else {
			throw new Error("Expected prompt result");
		}
	});

	it("provides /boost and /boots slash command with Boost Lead Orchestrator prompt", async () => {
		const cmd = BUILTIN_AGY_COMPAT_SLASH_COMMANDS.find(c => c.name === "boost");
		expect(cmd).toBeDefined();
		expect(cmd?.aliases).toContain("boots");

		if (!cmd || !cmd.handle) {
			throw new Error("boost command or handle not found");
		}
		const result = await cmd.handle(
			{ name: "boost", args: "tối ưu hóa pipeline video", text: "boost tối ưu hóa pipeline video" },
			{} as unknown as SlashCommandRuntime,
		);
		expect(result).toBeDefined();
		if (result && "prompt" in result) {
			expect(result.prompt).toContain("<BOOST>");
			expect(result.prompt).toContain("Boost Lead Orchestrator");
			expect(result.prompt).toContain("Zero Questionnaire Traps");
			expect(result.prompt).toContain("Decompose & Parallel Dispatch (DeepCoder & DeepInvestigator Engine)");
			expect(result.prompt).toContain("generative-ui");
			expect(result.prompt).toContain("tối ưu hóa pipeline video");
		} else {
			throw new Error("Expected prompt result");
		}

		const agents = loadBundledAgents();
		expect(getAgent(agents, "boost")?.name).toBe("teamwork-orchestrator");
		expect(getAgent(agents, "boots")?.name).toBe("teamwork-orchestrator");
	});

	it("provides /ultra-preview and /ultra slash command with OpenAI Codex 0.166.0 Ultra Multi-Agent V2 & xhigh reasoning contract", async () => {
		const cmd = BUILTIN_AGY_COMPAT_SLASH_COMMANDS.find(c => c.name === "ultra-preview");
		expect(cmd).toBeDefined();
		expect(cmd?.aliases).toContain("ultra");
		expect(cmd?.aliases).toContain("codex-ultra");

		if (!cmd || !cmd.handle) {
			throw new Error("ultra-preview command or handle not found");
		}
		const result = await cmd.handle(
			{
				name: "ultra-preview",
				args: "xây dựng hệ thống distributed lock",
				text: "/ultra-preview xây dựng hệ thống distributed lock",
			},
			{} as unknown as SlashCommandRuntime,
		);
		expect(result).toBeDefined();
		if (result && "prompt" in result) {
			expect(result.prompt).toContain("<ULTRA>");
			expect(result.prompt).toContain("Maximum reasoning with automatic task delegation");
			expect(result.prompt).toContain('multi_agent_reasoning_effort = "xhigh"');
			expect(result.prompt).toContain("Critical Path vs. Sidecar Delegation");
			expect(result.prompt).toContain("NOT ALONE in the codebase");
			expect(result.prompt).toContain("teamwork-awaiter");
			expect(result.prompt).toContain("local://ultra-board.md");
			expect(result.prompt).toContain("Persistent Mode & End-to-End Ownership");
			expect(result.prompt).toContain("xây dựng hệ thống distributed lock");
		} else {
			throw new Error("Expected prompt result");
		}

		const expandedUltra = await expandAgyCompatSlashCommand("/ultra refactor database connection pool");
		expect(expandedUltra).toContain("<ULTRA>");
		expect(expandedUltra).toContain("refactor database connection pool");

		const withMeta = buildUltraPreviewPrompt("test task", "GPT-6-Astra", "xhigh");
		expect(withMeta).toContain("(Model: GPT-6-Astra, Reasoning Effort: xhigh)");

		const resolvedNoModel = resolveUltraPreviewModel({
			model: undefined,
			configuredThinkingLevel: () => undefined,
			resolveRoleModelWithThinking: () => ({ model: undefined, thinkingLevel: undefined }),
		} as never);
		expect(resolvedNoModel.thinkingLevel).toBe(Effort.XHigh);
	});

	it("provides /grill-me and /grill slash command matching AGY <GRILL_ME> design-tree interview contract and command stacking", async () => {
		const cmd = BUILTIN_AGY_COMPAT_SLASH_COMMANDS.find(c => c.name === "grill-me");
		expect(cmd).toBeDefined();
		expect(cmd?.aliases).toContain("grill");
		expect(cmd?.description).toContain("Interview me to align on a plan");

		if (!cmd || !cmd.handle) {
			throw new Error("grill-me command or handle not found");
		}
		const result = await cmd.handle(
			{
				name: "grill-me",
				args: "thiết kế hệ thống rate limiter phân tán",
				text: "/grill-me thiết kế hệ thống rate limiter phân tán",
			},
			{} as unknown as SlashCommandRuntime,
		);
		expect(result).toBeDefined();
		if (result && "prompt" in result) {
			expect(result.prompt).toContain("<GRILL_ME>");
			expect(result.prompt).toContain(
				"The user has requested that you interview them about every aspect of their task until you've reach a shared understanding.",
			);
			expect(result.prompt).toContain(
				"Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.",
			);
			expect(result.prompt).toContain("- Ask the questions one at a time.");
			expect(result.prompt).toContain(
				"- If a question can be answered by exploring the codebase, explore the codebase instead.",
			);
			expect(result.prompt).toContain("</GRILL_ME>");
			expect(result.prompt).toContain("thiết kế hệ thống rate limiter phân tán");
		} else {
			throw new Error("Expected prompt result");
		}

		// Verify expansion for `/plan /grill-me <prompt>` and headless `-p "/grill-me <prompt>"`
		const expanded = await expandAgyCompatSlashCommand("/grill-me build a caching layer");
		expect(expanded).toContain("<GRILL_ME>");
		expect(expanded).toContain("build a caching layer");

		const expandedAlias = await expandAgyCompatSlashCommand("/grill refactor auth module");
		expect(expandedAlias).toContain("<GRILL_ME>");
		expect(expandedAlias).toContain("refactor auth module");
	});

	it("Case 1: aligns /teamwork-fork and /teamwork-fork-preview Sentinel prompts with AGY dispatch-only & SCOPE.md contract", () => {
		const forkPrompt = buildTeamworkForkPrompt("refactor payment gateway");
		expect(forkPrompt).toContain("<TEAMWORK_FORK>");
		expect(forkPrompt).toContain("DISPATCH-ONLY");
		expect(forkPrompt).toContain(".agents/SCOPE.md");
		expect(forkPrompt).toContain("refactor payment gateway");

		const forkPreviewPrompt = buildTeamworkForkPreviewPrompt("audit auth module", "Gemini 4 Argon");
		expect(forkPreviewPrompt).toContain("<TEAMWORK_FORK_PREVIEW>");
		expect(forkPreviewPrompt).toContain("Gemini 4 Argon");
		expect(forkPreviewPrompt).toContain("DISPATCH-ONLY");
		expect(forkPreviewPrompt).toContain(".agents/SCOPE.md");
		expect(forkPreviewPrompt).toContain("audit auth module");
	});

	it("Case 2 & 3: Forensic Auditor INTEGRITY VIOLATION and Reviewer REQUEST_CHANGES trigger gate rejection in inspectTeamworkStatus", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-tw-case2-"));
		try {
			const agentsDir = path.join(tmpDir, ".agents");
			await fs.mkdir(path.join(agentsDir, "TeamworkAuditor"), { recursive: true });
			await Bun.write(
				path.join(agentsDir, "ORIGINAL_REQUEST.md"),
				"# Original User Request\n\n## 2026-10-14T10:00:00Z\nBuild tax calculator from scratch.\n",
			);
			await Bun.write(
				path.join(agentsDir, "TeamworkAuditor", "audit_report.md"),
				"## Forensic Audit Report\n\n**Verdict**: INTEGRITY VIOLATION\n\n### Phase Results\n- Facade & Zero-Mock Check: FAIL — mocked calculateTax return value\n",
			);

			const status = await inspectTeamworkStatus(tmpDir);
			expect(status.exists).toBe(true);
			expect(status.gateStatus.verdict).toBe("REJECTED");
			expect(status.overallStatus).toBe("CHANGES_REQUESTED");
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("Case 4 & 5: tracks milestones from SCOPE.md and SWE Light progress.md alongside multi-agent GATE_STATUS.md matrix", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-tw-case4-"));
		try {
			const agentsDir = path.join(tmpDir, ".agents");
			await fs.mkdir(path.join(agentsDir, "TeamworkSweLight"), { recursive: true });
			await fs.mkdir(path.join(agentsDir, "TeamworkChallenger"), { recursive: true });
			await Bun.write(
				path.join(agentsDir, "SCOPE.md"),
				[
					"# Scope: Rate Limiter",
					"",
					"| Milestone | Status | Details |",
					"|---|---|---|",
					"| M1: Token Bucket Core | COMPLETED | Implemented atomic refill |",
					"| M2: Adversarial Stress Harness | IN_PROGRESS | Running 100k concurrent requests |",
				].join("\n"),
			);
			await Bun.write(
				path.join(agentsDir, "TeamworkSweLight", "GATE_STATUS.md"),
				[
					"## Gate — Iteration 2",
					"| Milestone | Verdict | Notes |",
					"|---|---|---|",
					"| M1 | APPROVE | Reviewer approved |",
					"| M2 | CLEAN | Forensic auditor clean |",
				].join("\n"),
			);
			await Bun.write(
				path.join(agentsDir, "TeamworkChallenger", "handoff.md"),
				"## Challenge Summary\n- **Verdict**: APPROVE\n",
			);

			const status = await inspectTeamworkStatus(tmpDir);
			expect(status.milestones).toHaveLength(2);
			expect(status.milestones[0]?.id).toBe("M1");
			expect(status.milestones[0]?.status).toBe("COMPLETED");
			expect(status.milestones[1]?.id).toBe("M2");
			expect(status.milestones[1]?.status).toBe("IN_PROGRESS");
			expect(status.gateStatus.history).toHaveLength(2);
			expect(status.overallStatus).toBe("IN_PROGRESS");
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("Case 6: enforces Binary Veto when === VICTORY AUDIT REPORT === emits VICTORY REJECTED and certifies only on VICTORY CONFIRMED", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-tw-case6-"));
		try {
			const agentsDir = path.join(tmpDir, ".agents");
			const victoryDir = path.join(agentsDir, "TeamworkVictoryAuditor");
			await fs.mkdir(victoryDir, { recursive: true });
			await Bun.write(
				path.join(agentsDir, "ORIGINAL_REQUEST.md"),
				"# Original User Request\n\n## 2026-10-14T12:00:00Z\nImplement CLI with --json flag.\n",
			);
			// Even if milestones claim COMPLETED in progress.md:
			await Bun.write(
				path.join(agentsDir, "progress.md"),
				"| Milestone | Status | Details |\n|---|---|---|\n| M1: CLI | COMPLETED | Done |\n",
			);
			// Phase 6a: Victory Auditor rejects due to Phase C discrepancy
			await Bun.write(
				path.join(victoryDir, "victory_report.md"),
				[
					"=== VICTORY AUDIT REPORT ===",
					"",
					"VERDICT: VICTORY REJECTED",
					"",
					"PHASE A — TIMELINE:",
					"  Result: PASS",
					"  Anomalies: none",
					"",
					"PHASE B — INTEGRITY CHECK:",
					"  Mode: Development",
					"  Result: PASS",
					"  Details: Zero fake mocks",
					"",
					"PHASE C — INDEPENDENT TEST EXECUTION:",
					"  Test command: bun test",
					"  Your results: 4 passed, 1 failed (--json flag missing)",
					"  Claimed results: 5 passed",
					"  Match: NO — --json flag not implemented",
				].join("\n"),
			);

			const rejectedStatus = await inspectTeamworkStatus(tmpDir);
			expect(rejectedStatus.victoryStatus.verdict).toBe("VICTORY REJECTED");
			// Binary veto MUST override the milestone's COMPLETED claim!
			expect(rejectedStatus.overallStatus).toBe("VICTORY REJECTED");
			expect(formatTeamworkStatus(rejectedStatus)).toContain("VICTORY REJECTED");

			// Phase 6b: After remediation and re-audit, Victory Auditor confirms
			await Bun.write(
				path.join(victoryDir, "victory_report.md"),
				[
					"=== VICTORY AUDIT REPORT ===",
					"",
					"VERDICT: VICTORY CONFIRMED",
					"",
					"PHASE A — TIMELINE:",
					"  Result: PASS",
					"  Anomalies: none",
					"",
					"PHASE B — INTEGRITY CHECK:",
					"  Mode: Development",
					"  Result: PASS",
					"  Details: Clean",
					"",
					"PHASE C — INDEPENDENT TEST EXECUTION:",
					"  Test command: bun test",
					"  Your results: 5 passed, 0 failed",
					"  Claimed results: 5 passed, 0 failed",
					"  Match: YES",
				].join("\n"),
			);

			const confirmedStatus = await inspectTeamworkStatus(tmpDir);
			expect(confirmedStatus.victoryStatus.verdict).toBe("VICTORY CONFIRMED");
			expect(confirmedStatus.overallStatus).toBe("VICTORY CONFIRMED");
			expect(formatTeamworkStatus(confirmedStatus)).toContain("VICTORY CONFIRMED");
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});
});
