import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BUILTIN_AGY_COMPAT_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-agy-compat";
import type { SlashCommandRuntime, TuiSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { formatTeamworkStatus, inspectTeamworkStatus } from "@oh-my-pi/pi-coding-agent/task/teamwork-status";

describe("Teamwork Status Inspector & Dashboard", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "teamwork-status-test-"));
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("handles empty directory without .agents gracefully", async () => {
		const status = await inspectTeamworkStatus(tempDir);

		expect(status.exists).toBe(false);
		expect(status.overallStatus).toBe("NOT_FOUND");
		expect(status.milestones).toHaveLength(0);
		expect(status.gateStatus.exists).toBe(false);
		expect(status.victoryStatus.exists).toBe(false);
		expect(status.agents).toHaveLength(0);

		const formatted = formatTeamworkStatus(status);
		expect(formatted).toContain("TEAMWORK PROJECT STATUS & DASHBOARD");
		expect(formatted).toContain("NOT_FOUND");
		expect(formatted).toContain("No active teamwork project found");
	});

	it("handles directory with empty .agents folder", async () => {
		const agentDir = path.join(tempDir, ".agents");
		await fs.mkdir(agentDir, { recursive: true });

		const status = await inspectTeamworkStatus(tempDir);

		expect(status.exists).toBe(true);
		expect(status.originalRequest.exists).toBe(false);
		expect(status.overallStatus).toBe("INITIALIZING");
		expect(status.milestones).toHaveLength(0);

		const formatted = formatTeamworkStatus(status);
		expect(formatted).toContain("INITIALIZING");
		expect(formatted).toContain("no coordination files have been generated yet");
	});

	it("parses active project with ORIGINAL_REQUEST.md", async () => {
		const agentDir = path.join(tempDir, ".agents");
		await fs.mkdir(agentDir, { recursive: true });

		const originalRequestContent = `# Original User Request

## 2026-10-05T20:45:00Z

Người dùng yêu cầu: "xây dựng dashboard kiểm tra trạng thái teamwork cho CLI/TUI".
Kích hoạt toàn diện quy trình Multi-Agent Teamwork.
`;
		await fs.writeFile(path.join(agentDir, "ORIGINAL_REQUEST.md"), originalRequestContent, "utf-8");

		const status = await inspectTeamworkStatus(tempDir);

		expect(status.exists).toBe(true);
		expect(status.originalRequest.exists).toBe(true);
		expect(status.originalRequest.title).toBe("Original User Request");
		expect(status.originalRequest.timestamp).toBe("2026-10-05T20:45:00Z");
		expect(status.originalRequest.summary).toContain("xây dựng dashboard kiểm tra trạng thái teamwork");
		expect(status.overallStatus).toBe("IN_PROGRESS");

		const formatted = formatTeamworkStatus(status);
		expect(formatted).toContain("Original User Request");
		expect(formatted).toContain("2026-10-05T20:45:00Z");
		expect(formatted).toContain("xây dựng dashboard kiểm tra trạng thái teamwork");
	});

	it("parses milestone progress tables and updates badges", async () => {
		const agentDir = path.join(tempDir, ".agents");
		const orchestratorDir = path.join(agentDir, "TeamworkOrchestrator");
		await fs.mkdir(orchestratorDir, { recursive: true });

		const progressContent = `# Living Status Tracker: OMP Teamwork Agy

## Overall Status: IN_PROGRESS

## Milestone Progress

| Milestone | Status | Details |
|---|---|---|
| **M1: Architecture & Inspector** | COMPLETED | Implemented inspectTeamworkStatus module |
| **M2: Slash Command Integration** | IN_PROGRESS | Integrating /teamwork status and report |
| **M3: Test Suite & Audit** | PENDING | Comprehensive unit tests |
| **M4: Forensic Gate Review** | BLOCKED | Waiting on adversarial challenger results |
`;
		await fs.writeFile(path.join(orchestratorDir, "progress.md"), progressContent, "utf-8");

		const status = await inspectTeamworkStatus(tempDir);

		expect(status.milestones).toHaveLength(4);

		expect(status.milestones[0].id).toBe("M1");
		expect(status.milestones[0].title).toBe("Architecture & Inspector");
		expect(status.milestones[0].status).toBe("COMPLETED");
		expect(status.milestones[0].details).toContain("Implemented inspectTeamworkStatus");

		expect(status.milestones[1].id).toBe("M2");
		expect(status.milestones[1].title).toBe("Slash Command Integration");
		expect(status.milestones[1].status).toBe("IN_PROGRESS");

		expect(status.milestones[2].id).toBe("M3");
		expect(status.milestones[2].status).toBe("PENDING");

		expect(status.milestones[3].id).toBe("M4");
		expect(status.milestones[3].status).toBe("BLOCKED");

		const formatted = formatTeamworkStatus(status);
		expect(formatted).toContain("[✔ COMPLETED]");
		expect(formatted).toContain("[⏳ IN_PROGRESS]");
		expect(formatted).toContain("[  PENDING    ]");
		expect(formatted).toContain("[✖ BLOCKED   ]");
	});

	it("parses fallback checklist milestones when no table is present", async () => {
		const agentDir = path.join(tempDir, ".agents");
		await fs.mkdir(agentDir, { recursive: true });

		const planContent = `# Project Plan
- [x] M1: Explorer Reconnaissance
- [x] M2: Worker Implementation
- [ ] M3: Auditor Forensic Inspection
`;
		await fs.writeFile(path.join(agentDir, "plan.md"), planContent, "utf-8");

		const status = await inspectTeamworkStatus(tempDir);
		expect(status.milestones).toHaveLength(3);
		expect(status.milestones[0].status).toBe("COMPLETED");
		expect(status.milestones[1].status).toBe("COMPLETED");
		expect(status.milestones[2].status).toBe("PENDING");
	});

	it("parses gate status approvals and rejections", async () => {
		const agentDir = path.join(tempDir, ".agents");
		await fs.mkdir(agentDir, { recursive: true });

		// Scenario A: Approved gate
		const approvedGate = `# Gate Status
| Milestone | Verdict | Details |
|---|---|---|
| M1 | APPROVE | Clean review passed |
`;
		await fs.writeFile(path.join(agentDir, "GATE_STATUS.md"), approvedGate, "utf-8");

		let status = await inspectTeamworkStatus(tempDir);
		expect(status.gateStatus.exists).toBe(true);
		expect(status.gateStatus.verdict).toBe("APPROVE");
		expect(status.gateStatus.history).toHaveLength(1);
		expect(status.gateStatus.history[0].verdict).toBe("APPROVE");

		// Scenario B: Rejected gate / Changes requested
		const rejectedGate = `# Gate Status
**Verdict**: REQUEST_CHANGES
**Reason**: Edge cases missing in test suite
`;
		await fs.writeFile(path.join(agentDir, "GATE_STATUS.md"), rejectedGate, "utf-8");

		status = await inspectTeamworkStatus(tempDir);
		expect(status.gateStatus.verdict).toBe("REQUEST_CHANGES");
		expect(status.overallStatus).toBe("CHANGES_REQUESTED");

		const formatted = formatTeamworkStatus(status);
		expect(formatted).toContain("REQUEST_CHANGES");
		expect(formatted).toContain("[CHANGES_REQUESTED]");
	});
	it("correctly resolves negative gate verdicts without false positives on APPROVE", async () => {
		const agentDir = path.join(tempDir, ".agents");
		await fs.mkdir(agentDir, { recursive: true });

		// Test 1: NOT APPROVED must resolve to REJECTED, not APPROVE
		await fs.writeFile(
			path.join(agentDir, "GATE_STATUS.md"),
			"# Gate Status\n**Verdict**: NOT APPROVED\n**Reason**: Flaws found",
			"utf-8",
		);

		let status = await inspectTeamworkStatus(tempDir);
		expect(status.gateStatus.verdict).toBe("REJECTED");
		expect(status.overallStatus).toBe("CHANGES_REQUESTED");

		// Test 2: FAIL APPROVE must resolve to REJECTED
		await fs.writeFile(path.join(agentDir, "GATE_STATUS.md"), "# Gate Status\n**Verdict**: FAIL APPROVE\n", "utf-8");
		status = await inspectTeamworkStatus(tempDir);
		expect(status.gateStatus.verdict).toBe("REJECTED");

		// Test 3: VIOLATION must resolve to REJECTED
		await fs.writeFile(path.join(agentDir, "GATE_STATUS.md"), "# Gate Status\n**Verdict**: VIOLATION\n", "utf-8");
		status = await inspectTeamworkStatus(tempDir);
		expect(status.gateStatus.verdict).toBe("REJECTED");

		// Test 4: Positive APPROVE still resolves to APPROVE
		await fs.writeFile(path.join(agentDir, "GATE_STATUS.md"), "# Gate Status\n**Verdict**: APPROVE\n", "utf-8");
		status = await inspectTeamworkStatus(tempDir);
		expect(status.gateStatus.verdict).toBe("APPROVE");
	});

	it("isolates table column mapping and does not default missing columns to index 0", async () => {
		const agentDir = path.join(tempDir, ".agents");
		await fs.mkdir(agentDir, { recursive: true });

		// Table with only Verdict column: milestone should NOT be defaulted to index 0 ("REJECTED")
		const singleColGate = `# Gate Status\n| Verdict |\n|---|\n| REJECTED |\n`;
		await fs.writeFile(path.join(agentDir, "GATE_STATUS.md"), singleColGate, "utf-8");

		const status = await inspectTeamworkStatus(tempDir);
		expect(status.gateStatus.verdict).toBe("REJECTED");
		expect(status.gateStatus.history).toHaveLength(1);
		expect(status.gateStatus.history[0].milestone).toBeUndefined();
		expect(status.gateStatus.history[0].verdict).toBe("REJECTED");
	});

	it("caps milestones and history to 50 and bounds formatted output length", async () => {
		const agentDir = path.join(tempDir, ".agents");
		await fs.mkdir(agentDir, { recursive: true });

		// Generate progress with 120 milestones
		const milestoneRows = Array.from({ length: 120 }, (_, i) => `| M${i + 1} | PENDING | Detail ${i + 1} |`).join(
			"\n",
		);
		const progressContent = `# Progress\n| Milestone | Status | Details |\n|---|---|---|\n${milestoneRows}\n`;
		await fs.writeFile(path.join(agentDir, "progress.md"), progressContent, "utf-8");

		// Generate gate status with 80 history entries
		const historyRows = Array.from({ length: 80 }, (_, i) => `| M${i + 1} | APPROVE | Clean review ${i + 1} |`).join(
			"\n",
		);
		const gateContent = `# Gate Status\n| Milestone | Verdict | Details |\n|---|---|---|\n${historyRows}\n`;
		await fs.writeFile(path.join(agentDir, "GATE_STATUS.md"), gateContent, "utf-8");

		const status = await inspectTeamworkStatus(tempDir);
		expect(status.milestones).toHaveLength(120);
		expect(status.gateStatus.history).toHaveLength(80);

		const formatted = formatTeamworkStatus(status);
		expect(formatted).toContain("capped at 50");
		expect(formatted).toContain("... and 70 more milestone(s) (capped at 50)");
		expect(formatted).toContain("... and 30 more history entry/entries (capped at 50)");
		// Output must be bounded to safe limit (<= 65536)
		expect(formatted.length).toBeLessThanOrEqual(65536);
	});

	it("falls back to TeamworkAuditor report when GATE_STATUS.md is absent", async () => {
		const agentDir = path.join(tempDir, ".agents");
		const auditorDir = path.join(agentDir, "TeamworkAuditor");
		await fs.mkdir(auditorDir, { recursive: true });

		const auditReport = `# Forensic Integrity & Gap Audit Report
The teamwork orchestration agents have been forensically verified.
**Verdict**: \`CLEAN\`
`;
		await fs.writeFile(path.join(auditorDir, "audit_report.md"), auditReport, "utf-8");

		const status = await inspectTeamworkStatus(tempDir);
		expect(status.gateStatus.exists).toBe(true);
		expect(status.gateStatus.verdict).toBe("CLEAN");

		const formatted = formatTeamworkStatus(status);
		expect(formatted).toContain("Verdict:    CLEAN");
	});

	it("parses victory report certification", async () => {
		const agentDir = path.join(tempDir, ".agents");
		const victoryDir = path.join(agentDir, "TeamworkVictoryAuditor");
		await fs.mkdir(victoryDir, { recursive: true });

		const victoryReport = `# Teamwork Victory Auditor - Final Certification Report

**Auditor**: Teamwork Victory Auditor
**Date**: 2026-10-05
**Final Verdict**: **VICTORY CONFIRMED**
**Repository**: \`inut-team/omp-teamwork-agy\`
**Target Branch**: \`feature/teamwork-agy\`
**Certified Commit**: \`b47d6283828c8d85c88dc2377a225f5373e99cb3\`
`;
		await fs.writeFile(path.join(victoryDir, "victory_report.md"), victoryReport, "utf-8");

		const status = await inspectTeamworkStatus(tempDir);
		expect(status.victoryStatus.exists).toBe(true);
		expect(status.victoryStatus.verdict).toBe("VICTORY CONFIRMED");
		expect(status.victoryStatus.certifiedCommit).toBe("b47d6283828c8d85c88dc2377a225f5373e99cb3");
		expect(status.victoryStatus.repository).toBe("inut-team/omp-teamwork-agy");
		expect(status.victoryStatus.branch).toBe("feature/teamwork-agy");
		expect(status.overallStatus).toBe("VICTORY CONFIRMED");

		const formatted = formatTeamworkStatus(status);
		expect(formatted).toContain("VICTORY CONFIRMED");
		expect(formatted).toContain("b47d6283828c8d85c88dc2377a225f5373e99cb3");
	});

	it("discovers subagent cohorts and handoff files", async () => {
		const agentDir = path.join(tempDir, ".agents");
		const cohorts = ["TeamworkOrchestrator", "TeamworkExplorer", "TeamworkWorker", "TeamworkReviewer"];

		for (const cohort of cohorts) {
			const dir = path.join(agentDir, cohort);
			await fs.mkdir(dir, { recursive: true });
			await fs.writeFile(path.join(dir, "handoff.md"), `# ${cohort} Handoff\nDone.`, "utf-8");
		}

		const status = await inspectTeamworkStatus(tempDir);
		expect(status.agents).toHaveLength(4);
		for (const cohort of cohorts) {
			const found = status.agents.find(a => a.name === cohort);
			expect(found).toBeDefined();
			expect(found?.hasHandoff).toBe(true);
			expect(found?.handoffPath).toBeDefined();
		}

		const formatted = formatTeamworkStatus(status);
		expect(formatted).toContain("TeamworkOrchestrator");
		expect(formatted).toContain("[handoff: ✔]");
	});

	it("executes /teamwork status and /teamwork report slash command via handle", async () => {
		const agentDir = path.join(tempDir, ".agents");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(
			path.join(agentDir, "ORIGINAL_REQUEST.md"),
			"# Test Request\n## 2026-10-05\nRequest: Deploy feature",
			"utf-8",
		);

		const cmd = BUILTIN_AGY_COMPAT_SLASH_COMMANDS.find(c => c.name === "teamwork-preview");
		expect(cmd).toBeDefined();
		expect(cmd?.aliases).toContain("teamwork");
		expect(cmd?.handle).toBeDefined();

		if (!cmd?.handle) throw new Error("Command handle missing");

		let outputText = "";
		const mockRuntime: SlashCommandRuntime = {
			cwd: tempDir,
			output: (text: string) => {
				outputText = text;
			},
		} as unknown as SlashCommandRuntime;

		// Test /teamwork status
		const resultStatus = await cmd.handle(
			{ name: "teamwork", args: "status", text: "/teamwork status" },
			mockRuntime,
		);

		expect(resultStatus).toBeDefined();
		if (resultStatus && "prompt" in resultStatus) {
			expect(resultStatus.prompt).toContain("TEAMWORK PROJECT STATUS & DASHBOARD");
			expect(resultStatus.prompt).toContain("Deploy feature");
		} else {
			throw new Error("Expected prompt result containing status report");
		}
		expect(outputText).toContain("TEAMWORK PROJECT STATUS & DASHBOARD");

		// Test /teamwork report
		let reportOutput = "";
		const reportRuntime: SlashCommandRuntime = {
			cwd: tempDir,
			output: (text: string) => {
				reportOutput = text;
			},
		} as unknown as SlashCommandRuntime;

		const resultReport = await cmd.handle(
			{ name: "teamwork", args: "report", text: "/teamwork report" },
			reportRuntime,
		);
		expect(resultReport).toBeDefined();
		if (resultReport && "prompt" in resultReport) {
			expect(resultReport.prompt).toContain("TEAMWORK PROJECT STATUS & DASHBOARD");
		}
		expect(reportOutput).toContain("TEAMWORK PROJECT STATUS & DASHBOARD");

		// Test normal /teamwork command with non-status args passes through to orchestration prompt
		const regularResult = await cmd.handle(
			{ name: "teamwork", args: "xây dựng api gateway", text: "/teamwork xây dựng api gateway" },
			mockRuntime,
		);
		if (regularResult && "prompt" in regularResult) {
			expect(regularResult.prompt).toContain("<TEAMWORK>");
			expect(regularResult.prompt).toContain("xây dựng api gateway");
		} else {
			throw new Error("Expected regular prompt result");
		}
		// Test non-greedy subcommand boundary: "statusupdate my api" and "reporting bug" pass through to orchestration
		const statusUpdateResult = await cmd.handle(
			{ name: "teamwork", args: "statusupdate my api", text: "/teamwork statusupdate my api" },
			mockRuntime,
		);
		if (statusUpdateResult && "prompt" in statusUpdateResult) {
			expect(statusUpdateResult.prompt).toContain("<TEAMWORK>");
			expect(statusUpdateResult.prompt).toContain("statusupdate my api");
		} else {
			throw new Error("Expected statusupdate to pass through to orchestration prompt");
		}

		const reportingResult = await cmd.handle(
			{ name: "teamwork", args: "reporting bug to team", text: "/teamwork reporting bug to team" },
			mockRuntime,
		);
		if (reportingResult && "prompt" in reportingResult) {
			expect(reportingResult.prompt).toContain("<TEAMWORK>");
			expect(reportingResult.prompt).toContain("reporting bug to team");
		} else {
			throw new Error("Expected reporting to pass through to orchestration prompt");
		}
	});

	it("executes /teamwork status slash command via handleTui", async () => {
		const agentDir = path.join(tempDir, ".agents");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(
			path.join(agentDir, "ORIGINAL_REQUEST.md"),
			"# TUI Test Request\n## 2026-10-05\nRequest: Test TUI integration",
			"utf-8",
		);

		const cmd = BUILTIN_AGY_COMPAT_SLASH_COMMANDS.find(c => c.name === "teamwork-preview");
		expect(cmd?.handleTui).toBeDefined();
		if (!cmd?.handleTui) throw new Error("Command handleTui missing");

		let editorText = "previous text";
		let tuiOutput = "";

		const mockTuiRuntime = {
			output: (text: string) => {
				tuiOutput = text;
			},
			ctx: {
				editor: {
					setText: (text: string) => {
						editorText = text;
					},
				},
				sessionManager: {
					getCwd: () => tempDir,
				},
				showStatus: (text: string) => {
					tuiOutput = text;
				},
			},
		};

		const tuiResult = await cmd.handleTui(
			{ name: "teamwork", args: "status", text: "/teamwork status" },
			mockTuiRuntime as unknown as TuiSlashCommandRuntime,
		);

		expect(tuiResult).toEqual({ consumed: true });
		expect(editorText).toBe("");
		expect(tuiOutput).toContain("TEAMWORK PROJECT STATUS & DASHBOARD");
		expect(tuiOutput).toContain("Test TUI integration");
	});

	it("inspects current project real .agents directory without throwing", async () => {
		const status = await inspectTeamworkStatus(process.cwd());
		expect(status).toBeDefined();
		expect(typeof status.exists).toBe("boolean");
		const formatted = formatTeamworkStatus(status);
		expect(formatted).toContain("TEAMWORK PROJECT STATUS & DASHBOARD");

		if (status.exists) {
			expect(typeof status.overallStatus).toBe("string");
			if (status.originalRequest.exists) {
				expect(status.milestones.length).toBeGreaterThanOrEqual(0);
			}
		}
	});
});
