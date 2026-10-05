import * as fs from "node:fs/promises";
import path from "node:path";

export type TeamworkGateVerdict =
	| "APPROVE"
	| "REQUEST_CHANGES"
	| "CLEAN"
	| "AUDIT_PASSED"
	| "REJECTED"
	| "PENDING"
	| string;

export type TeamworkVictoryVerdict = "VICTORY CONFIRMED" | "VICTORY REJECTED" | "PENDING" | "NONE";

export interface TeamworkMilestone {
	id: string;
	title: string;
	status: string;
	details?: string;
}

export interface TeamworkGateHistoryEntry {
	milestone?: string;
	verdict: string;
	details?: string;
}

export interface TeamworkGateInfo {
	exists: boolean;
	path?: string;
	verdict?: TeamworkGateVerdict;
	raw?: string;
	history: TeamworkGateHistoryEntry[];
}

export interface TeamworkVictoryInfo {
	exists: boolean;
	path?: string;
	verdict: TeamworkVictoryVerdict;
	timestamp?: string;
	certifiedCommit?: string;
	repository?: string;
	branch?: string;
	raw?: string;
}

export interface TeamworkAgentSummary {
	name: string;
	hasHandoff: boolean;
	handoffPath?: string;
	files: string[];
}

export interface TeamworkOriginalRequestInfo {
	exists: boolean;
	path?: string;
	title?: string;
	timestamp?: string;
	summary?: string;
	raw?: string;
}

export interface TeamworkProjectStatus {
	exists: boolean;
	agentDir: string;
	originalRequest: TeamworkOriginalRequestInfo;
	overallStatus: string;
	milestones: TeamworkMilestone[];
	gateStatus: TeamworkGateInfo;
	victoryStatus: TeamworkVictoryInfo;
	agents: TeamworkAgentSummary[];
}

async function readFileSafe(filePath: string): Promise<string | undefined> {
	try {
		const file = Bun.file(filePath);
		if (!(await file.exists())) return undefined;
		return await file.text();
	} catch {
		return undefined;
	}
}
function cleanMarkdown(text: string): string {
	return text
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/__([^_]+)__/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/^\s*[*_`]+|[*_`]+\s*$/g, "")
		.trim();
}

function resolveGateVerdict(raw: string): TeamworkGateVerdict {
	const upper = raw.toUpperCase();
	if (
		upper.includes("NOT APPROVED") ||
		upper.includes("NOT_APPROVED") ||
		upper.includes("REJECT") ||
		upper.includes("FAIL") ||
		upper.includes("VIOLATION")
	) {
		return "REJECTED";
	}
	if (upper.includes("REQUEST_CHANGES") || upper.includes("REQUEST CHANGES")) {
		return "REQUEST_CHANGES";
	}
	if (
		upper.includes("APPROVE") ||
		upper.includes("AUDIT_PASSED") ||
		upper.includes("AUDIT PASSED") ||
		upper.includes("PASS")
	) {
		return "APPROVE";
	}
	if (upper.includes("CLEAN")) {
		return "CLEAN";
	}
	return raw;
}

function parseOriginalRequest(content: string, filePath: string): TeamworkOriginalRequestInfo {
	let title: string | undefined;
	let timestamp: string | undefined;
	let summary: string | undefined;

	const titleMatch = content.match(/^#\s+(.+)$/m);
	if (titleMatch) {
		title = cleanMarkdown(titleMatch[1]);
	}

	const timeMatch =
		content.match(/##\s+(\d{4}-\d{2}-\d{2}T[^\s\n]+)/) ??
		content.match(/(?:Timestamp|Date)[*_\s]*:\s*[`*]*([^\n\r`*]+)/i);
	if (timeMatch) {
		timestamp = cleanMarkdown(timeMatch[1]);
	}
	const reqMatch =
		content.match(/(?:Người dùng yêu cầu|User [Rr]equest|Request)[*_\s]*:\s*"?([^"\n\r]+)"?/i) ??
		content.match(/###\s+(?:Problem & Feature|Overview|Goal)[^\n]*\n+([^#\n\r]+)/i);
	if (reqMatch) {
		summary = cleanMarkdown(reqMatch[1]);
	} else {
		const lines = content.split("\n");
		for (const line of lines) {
			const trimmed = line.trim();
			if (
				trimmed &&
				!trimmed.startsWith("#") &&
				!trimmed.startsWith("-") &&
				!trimmed.startsWith("=") &&
				!trimmed.startsWith("|")
			) {
				summary = trimmed;
				break;
			}
		}
	}

	return {
		exists: true,
		path: filePath,
		title,
		timestamp,
		summary,
		raw: content,
	};
}

interface ProgressParsed {
	overallStatus?: string;
	milestones: TeamworkMilestone[];
}

function parseProgress(content: string): ProgressParsed {
	let overallStatus: string | undefined;
	const milestones: TeamworkMilestone[] = [];

	const overallMatch =
		content.match(/##\s*Overall Status:\s*([^\n\r]+)/i) ?? content.match(/Overall Status:\s*([^\n\r]+)/i);
	if (overallMatch) {
		overallStatus = overallMatch[1].trim();
	}

	const lines = content.split("\n");
	let inMilestoneTable = false;
	let headerIndices: { milestone: number; status: number; details: number } | undefined;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line.startsWith("|") || !line.endsWith("|")) {
			inMilestoneTable = false;
			continue;
		}

		const cells = line
			.slice(1, -1)
			.split(/(?<!\\)\|/)
			.map(c => c.replace(/\\\|/g, "|").trim());

		if (cells.some(c => /milestone/i.test(c))) {
			inMilestoneTable = true;
			const mIdx = cells.findIndex(c => /milestone/i.test(c));
			const sIdx = cells.findIndex(c => /status/i.test(c));
			const dIdx = cells.findIndex(c => /detail|desc/i.test(c));
			headerIndices = {
				milestone: mIdx,
				status: sIdx,
				details: dIdx,
			};
			continue;
		}

		if (inMilestoneTable && headerIndices) {
			if (cells.every(c => /^[-:\s]+$/.test(c))) {
				continue;
			}

			const mRaw =
				headerIndices.milestone !== -1 && headerIndices.milestone < cells.length
					? cells[headerIndices.milestone]
					: "";
			const sRaw =
				headerIndices.status !== -1 && headerIndices.status < cells.length ? cells[headerIndices.status] : "";
			const dRaw =
				headerIndices.details !== -1 && headerIndices.details < cells.length ? cells[headerIndices.details] : "";

			const cleanM = cleanMarkdown(mRaw);
			const cleanS = cleanMarkdown(sRaw);
			const cleanD = cleanMarkdown(dRaw);

			if (!cleanM && !cleanS) continue;

			const colonIdx = cleanM.indexOf(":");
			let id = cleanM;
			let title = cleanM;
			if (colonIdx !== -1) {
				id = cleanM.slice(0, colonIdx).trim();
				title = cleanM.slice(colonIdx + 1).trim();
			}

			milestones.push({
				id,
				title,
				status: cleanS || "UNKNOWN",
				details: cleanD || undefined,
			});
		}
	}

	if (milestones.length === 0) {
		for (const line of lines) {
			const checkMatch = line.match(/^-\s*\[([ xX])\]\s*(?:(M\d+)[:\s]+)?(.+)$/);
			if (checkMatch) {
				const isDone = checkMatch[1].toLowerCase() === "x";
				const id = checkMatch[2] ?? `M${milestones.length + 1}`;
				const title = checkMatch[3].trim();
				milestones.push({
					id,
					title,
					status: isDone ? "COMPLETED" : "PENDING",
				});
			}
		}
	}

	return { overallStatus, milestones };
}

function parseGateStatusContent(content: string, filePath: string): TeamworkGateInfo {
	let verdict: TeamworkGateVerdict | undefined;
	const history: TeamworkGateHistoryEntry[] = [];

	const lines = content.split("\n");
	let inTable = false;
	let colIndices: { milestone: number; verdict: number; details: number } | undefined;

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
			inTable = false;
			continue;
		}
		const cells = trimmed
			.slice(1, -1)
			.split(/(?<!\\)\|/)
			.map(c => c.replace(/\\\|/g, "|").trim());

		if (cells.some(c => /verdict|gate status|status/i.test(c))) {
			inTable = true;
			const vIdx = cells.findIndex(c => /verdict|gate status|status/i.test(c));
			const mIdx = cells.findIndex(c => /milestone|cohort|round/i.test(c));
			const dIdx = cells.findIndex(c => /detail|reason|notes/i.test(c));
			colIndices = {
				verdict: vIdx,
				milestone: mIdx,
				details: dIdx,
			};
			continue;
		}

		if (inTable && colIndices) {
			if (cells.every(c => /^[-:\s]+$/.test(c))) continue;
			const mRaw = cleanMarkdown(
				colIndices.milestone !== -1 && colIndices.milestone < cells.length ? cells[colIndices.milestone] : "",
			);
			const vRaw = cleanMarkdown(
				colIndices.verdict !== -1 && colIndices.verdict < cells.length ? cells[colIndices.verdict] : "",
			);
			const dRaw = cleanMarkdown(
				colIndices.details !== -1 && colIndices.details < cells.length ? cells[colIndices.details] : "",
			);
			if (vRaw) {
				const resolvedVerdict = resolveGateVerdict(vRaw);
				history.push({
					milestone: mRaw || undefined,
					verdict: resolvedVerdict,
					details: dRaw || undefined,
				});
				verdict = resolvedVerdict;
			}
		}
	}

	if (!verdict) {
		const verdictMatch =
			content.match(/(?:\*\*|##)?\s*(?:Final )?Verdict[*_\s]*:\s*[`*]*([A-Z_ ]+)/i) ??
			content.match(/(?:Gate Status|Audit Status|Status)[*_\s]*:\s*[`*]*([A-Z_ ]+)/i);
		if (verdictMatch) {
			verdict = verdictMatch[1].trim();
		}
	}

	if (verdict) {
		verdict = resolveGateVerdict(verdict);
	}

	return {
		exists: true,
		path: filePath,
		verdict,
		raw: content,
		history,
	};
}

function parseVictoryContent(content: string, filePath: string): TeamworkVictoryInfo {
	let verdict: TeamworkVictoryVerdict = "NONE";
	let certifiedCommit: string | undefined;
	let timestamp: string | undefined;
	let repository: string | undefined;
	let branch: string | undefined;

	const verdictMatch = content.match(/(?:Final Verdict|FINAL VERDICT|Verdict)[*_\s]*:\s*[`*]*([A-Z_ ]+)/i);
	if (verdictMatch) {
		const upper = verdictMatch[1].trim().toUpperCase();
		if (upper.includes("VICTORY CONFIRMED")) {
			verdict = "VICTORY CONFIRMED";
		} else if (upper.includes("VICTORY REJECTED")) {
			verdict = "VICTORY REJECTED";
		} else if (upper.includes("PENDING")) {
			verdict = "PENDING";
		}
	} else if (content.includes("VICTORY CONFIRMED")) {
		verdict = "VICTORY CONFIRMED";
	} else if (content.includes("VICTORY REJECTED")) {
		verdict = "VICTORY REJECTED";
	}

	const commitMatch = content.match(/(?:Certified Commit|Head Commit)[*_\s]*:\s*[`*]*([a-f0-9]{7,40})/i);
	if (commitMatch) {
		certifiedCommit = commitMatch[1].trim();
	}

	const timeMatch = content.match(/(?:Date|Timestamp)[*_\s]*:\s*[`*]*([^\n\r`*]+)/i);
	if (timeMatch) {
		timestamp = cleanMarkdown(timeMatch[1]);
	}

	const repoMatch = content.match(/(?:Repository|Target Repo)[*_\s]*:\s*[`*]*([^\s\n\r`*]+)/i);
	if (repoMatch) {
		repository = cleanMarkdown(repoMatch[1]);
	}

	const branchMatch = content.match(/(?:Target Branch|Branch)[*_\s]*:\s*[`*]*([^\s\n\r`*]+)/i);
	if (branchMatch) {
		branch = cleanMarkdown(branchMatch[1]);
	}

	return {
		exists: true,
		path: filePath,
		verdict,
		timestamp,
		certifiedCommit,
		repository,
		branch,
		raw: content,
	};
}

function deriveOverallStatus(
	victory: TeamworkVictoryInfo,
	gate: TeamworkGateInfo,
	progressOverall?: string,
	milestones: TeamworkMilestone[] = [],
	hasOriginalRequest: boolean = false,
): string {
	if (victory.verdict === "VICTORY CONFIRMED") {
		return "VICTORY CONFIRMED";
	}
	if (victory.verdict === "VICTORY REJECTED") {
		return "VICTORY REJECTED";
	}
	if (gate.verdict === "REQUEST_CHANGES" || gate.verdict === "REJECTED") {
		return "CHANGES_REQUESTED";
	}
	if (progressOverall) {
		return progressOverall;
	}
	if (milestones.length > 0) {
		const allCompleted = milestones.every(
			m =>
				m.status.toUpperCase() === "COMPLETED" ||
				m.status.toUpperCase() === "DONE" ||
				m.status.toUpperCase() === "PASS",
		);
		if (allCompleted) return "COMPLETED";
		const anyFailed = milestones.some(
			m =>
				m.status.toUpperCase() === "FAILED" ||
				m.status.toUpperCase() === "FAIL" ||
				m.status.toUpperCase() === "BLOCKED",
		);
		if (anyFailed) return "BLOCKED";
		return "IN_PROGRESS";
	}
	if (hasOriginalRequest) {
		return "IN_PROGRESS";
	}
	return "INITIALIZING";
}

export async function inspectTeamworkStatus(cwd: string = process.cwd()): Promise<TeamworkProjectStatus> {
	const resolved = path.resolve(cwd);
	const agentDir = path.basename(resolved) === ".agents" ? resolved : path.join(resolved, ".agents");

	const dirStat = await fs.stat(agentDir).catch(() => null);
	if (!dirStat || !dirStat.isDirectory()) {
		return {
			exists: false,
			agentDir,
			originalRequest: { exists: false },
			overallStatus: "NOT_FOUND",
			milestones: [],
			gateStatus: { exists: false, history: [] },
			victoryStatus: { exists: false, verdict: "NONE" },
			agents: [],
		};
	}

	// 1. Original Request
	const originalRequestPath = path.join(agentDir, "ORIGINAL_REQUEST.md");
	const originalRequestText = await readFileSafe(originalRequestPath);
	const originalRequest = originalRequestText
		? parseOriginalRequest(originalRequestText, originalRequestPath)
		: { exists: false };

	// 2. Progress / Milestones
	const progressCandidates = [
		path.join(agentDir, "TeamworkOrchestrator", "progress.md"),
		path.join(agentDir, "progress.md"),
		path.join(agentDir, "TeamworkOrchestrator", "plan.md"),
		path.join(agentDir, "plan.md"),
	];

	let progressParsed: ProgressParsed = { milestones: [] };
	for (const candidate of progressCandidates) {
		const text = await readFileSafe(candidate);
		if (text) {
			progressParsed = parseProgress(text);
			if (progressParsed.milestones.length > 0 || progressParsed.overallStatus) {
				break;
			}
		}
	}

	// 3. Gate Status
	const gateCandidates = [
		path.join(agentDir, "GATE_STATUS.md"),
		path.join(agentDir, "TeamworkOrchestrator", "GATE_STATUS.md"),
		path.join(agentDir, "TeamworkAuditor", "audit_report.md"),
		path.join(agentDir, "TeamworkAuditor", "handoff.md"),
	];

	let gateStatus: TeamworkGateInfo = { exists: false, history: [] };
	for (const candidate of gateCandidates) {
		const text = await readFileSafe(candidate);
		if (text) {
			gateStatus = parseGateStatusContent(text, candidate);
			if (gateStatus.verdict || gateStatus.history.length > 0) {
				break;
			}
		}
	}

	// 4. Victory Report
	const victoryCandidates = [
		path.join(agentDir, "TeamworkVictoryAuditor", "victory_report.md"),
		path.join(agentDir, "TeamworkVictoryAuditor", "handoff.md"),
		path.join(agentDir, "victory_report.md"),
	];

	let victoryStatus: TeamworkVictoryInfo = { exists: false, verdict: "NONE" };
	for (const candidate of victoryCandidates) {
		const text = await readFileSafe(candidate);
		if (text) {
			victoryStatus = parseVictoryContent(text, candidate);
			if (victoryStatus.verdict !== "NONE") {
				break;
			}
		}
	}

	// 5. Discover Subagent directories
	const agents: TeamworkAgentSummary[] = [];
	const entries = await fs.readdir(agentDir, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		if (entry.isDirectory() && !entry.name.startsWith(".")) {
			const subDir = path.join(agentDir, entry.name);
			const subEntries = await fs.readdir(subDir, { withFileTypes: true }).catch(() => []);
			const files = subEntries.map(e => e.name).sort();
			const hasHandoff = files.includes("handoff.md");
			agents.push({
				name: entry.name,
				hasHandoff,
				handoffPath: hasHandoff ? path.join(subDir, "handoff.md") : undefined,
				files,
			});
		}
	}

	const AGENT_ORDER = [
		"TeamworkOrchestrator",
		"TeamworkExplorer",
		"TeamworkWorker",
		"TeamworkReviewer",
		"TeamworkChallenger",
		"TeamworkAuditor",
		"TeamworkVictoryAuditor",
	];
	agents.sort((a, b) => {
		const aIdx = AGENT_ORDER.indexOf(a.name);
		const bIdx = AGENT_ORDER.indexOf(b.name);
		if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
		if (aIdx !== -1) return -1;
		if (bIdx !== -1) return 1;
		return a.name.localeCompare(b.name);
	});

	const overallStatus = deriveOverallStatus(
		victoryStatus,
		gateStatus,
		progressParsed.overallStatus,
		progressParsed.milestones,
		originalRequest.exists,
	);

	return {
		exists: true,
		agentDir,
		originalRequest,
		overallStatus,
		milestones: progressParsed.milestones,
		gateStatus,
		victoryStatus,
		agents,
	};
}

export function formatTeamworkStatus(status: TeamworkProjectStatus): string {
	const lines: string[] = [];
	const hr = "=".repeat(80);
	const subHr = (title: string) => `── ${title} ${"─".repeat(Math.max(2, 77 - title.length))}`;

	lines.push(hr);
	lines.push("                     TEAMWORK PROJECT STATUS & DASHBOARD");
	lines.push(hr);
	lines.push(`Directory:  ${status.agentDir}`);
	lines.push(`Overall:    [${status.overallStatus}]`);

	if (!status.exists) {
		lines.push("");
		lines.push("No active teamwork project found in:");
		lines.push(`  ${status.agentDir}`);
		lines.push("");
		lines.push("To start a new teamwork project, run:");
		lines.push("  /teamwork <your task description>");
		lines.push(hr);
		return lines.join("\n");
	}

	const isEmptyProject =
		!status.originalRequest.exists &&
		status.milestones.length === 0 &&
		!status.gateStatus.exists &&
		!status.victoryStatus.exists &&
		status.agents.length === 0;

	if (isEmptyProject) {
		lines.push("");
		lines.push("Teamwork directory exists, but no coordination files have been generated yet.");
		lines.push(hr);
		return lines.join("\n");
	}

	// 1. Original Request
	lines.push("");
	lines.push(subHr("ORIGINAL REQUEST"));
	if (status.originalRequest.exists) {
		if (status.originalRequest.title) lines.push(`Title:      ${status.originalRequest.title}`);
		if (status.originalRequest.timestamp) lines.push(`Timestamp:  ${status.originalRequest.timestamp}`);
		if (status.originalRequest.summary) lines.push(`Summary:    ${status.originalRequest.summary}`);
		if (status.originalRequest.path) lines.push(`File:       ${status.originalRequest.path}`);
	} else {
		lines.push("No ORIGINAL_REQUEST.md found.");
	}

	// 2. Milestones
	lines.push("");
	lines.push(subHr("MILESTONES"));
	if (status.milestones.length > 0) {
		const MAX_MILESTONES = 50;
		const displayMilestones = status.milestones.slice(0, MAX_MILESTONES);
		for (const m of displayMilestones) {
			const statusUpper = m.status.toUpperCase();
			let badge = `[${m.status}]`;
			let icon = "•";
			if (statusUpper === "COMPLETED" || statusUpper === "DONE" || statusUpper === "PASS") {
				badge = "[✔ COMPLETED]";
				icon = "✔";
			} else if (statusUpper === "IN_PROGRESS" || statusUpper === "RUNNING") {
				badge = "[⏳ IN_PROGRESS]";
				icon = "⏳";
			} else if (statusUpper === "PENDING") {
				badge = "[  PENDING    ]";
				icon = "○";
			} else if (statusUpper === "FAILED" || statusUpper === "BLOCKED") {
				badge = "[✖ BLOCKED   ]";
				icon = "✖";
			}
			lines.push(`  ${icon} ${m.id}: ${m.title}  ${badge}`);
			if (m.details) {
				lines.push(`    Details: ${m.details}`);
			}
		}
		if (status.milestones.length > MAX_MILESTONES) {
			lines.push(`  ... and ${status.milestones.length - MAX_MILESTONES} more milestone(s) (capped at 50)`);
		}
	} else {
		lines.push("No milestones recorded yet.");
	}

	// 3. Gate Status
	lines.push("");
	lines.push(subHr("GATE & AUDIT STATUS"));
	if (status.gateStatus.exists) {
		lines.push(`Verdict:    ${status.gateStatus.verdict ?? "UNKNOWN"}`);
		if (status.gateStatus.path) lines.push(`Source:     ${status.gateStatus.path}`);
		if (status.gateStatus.history.length > 0) {
			lines.push("History:");
			const MAX_HISTORY = 50;
			const displayHistory = status.gateStatus.history.slice(0, MAX_HISTORY);
			for (const h of displayHistory) {
				const mLabel = h.milestone ? `${h.milestone}: ` : "";
				const dLabel = h.details ? ` (${h.details})` : "";
				lines.push(`  • ${mLabel}${h.verdict}${dLabel}`);
			}
			if (status.gateStatus.history.length > MAX_HISTORY) {
				lines.push(
					`  ... and ${status.gateStatus.history.length - MAX_HISTORY} more history entry/entries (capped at 50)`,
				);
			}
		}
	} else {
		lines.push("No gate status recorded yet.");
	}

	// 4. Victory Certification
	lines.push("");
	lines.push(subHr("VICTORY CERTIFICATION"));
	if (status.victoryStatus.exists) {
		lines.push(`Verdict:    ${status.victoryStatus.verdict}`);
		if (status.victoryStatus.certifiedCommit) lines.push(`Commit:     ${status.victoryStatus.certifiedCommit}`);
		if (status.victoryStatus.timestamp) lines.push(`Timestamp:  ${status.victoryStatus.timestamp}`);
		if (status.victoryStatus.repository) lines.push(`Repository: ${status.victoryStatus.repository}`);
		if (status.victoryStatus.branch) lines.push(`Branch:     ${status.victoryStatus.branch}`);
		if (status.victoryStatus.path) lines.push(`Source:     ${status.victoryStatus.path}`);
	} else {
		lines.push("No victory certification report yet.");
	}

	// 5. Participating Agents
	lines.push("");
	lines.push(subHr("PARTICIPATING AGENTS"));
	if (status.agents.length > 0) {
		for (const agent of status.agents) {
			const handoffBadge = agent.hasHandoff ? "[handoff: ✔]" : "[handoff: ✖]";
			const fileCount = `${agent.files.length} file${agent.files.length === 1 ? "" : "s"}`;
			const filesList = agent.files.length > 0 ? ` (${agent.files.join(", ")})` : "";
			lines.push(`  • ${agent.name.padEnd(26)} ${handoffBadge} ${fileCount}${filesList}`);
		}
	} else {
		lines.push("No subagent cohorts recorded.");
	}

	lines.push(hr);
	const output = lines.join("\n");
	const MAX_OUTPUT_LENGTH = 65536;
	if (output.length > MAX_OUTPUT_LENGTH) {
		return `${output.slice(0, MAX_OUTPUT_LENGTH)}\n\n[Output truncated at 64KB to prevent display freeze]\n${hr}`;
	}
	return output;
}
