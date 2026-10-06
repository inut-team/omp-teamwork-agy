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

export interface TeamworkPerformanceMetrics {
	totalTokens: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	totalCost: number;
	durationMs: number;
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
	metrics?: TeamworkPerformanceMetrics;
}

export const AGENT_ORDER: ReadonlyArray<string> = [
	"TeamworkOrchestrator",
	"TeamworkExplorer",
	"TeamworkWorker",
	"TeamworkReviewer",
	"TeamworkChallenger",
	"TeamworkAuditor",
	"TeamworkVictoryAuditor",
	"TeamworkFork",
	"TeamworkForkPreview",
];

function getAgentOrderIndex(name: string): number {
	const exact = AGENT_ORDER.indexOf(name);
	if (exact !== -1) return exact;
	const base = name.replace(/[-_]\d+$/, "");
	const baseIdx = AGENT_ORDER.indexOf(base);
	if (baseIdx !== -1) return baseIdx + 0.1;
	return -1;
}

function parseDurationMs(raw: string): number {
	const text = raw.trim();
	const minSecMatch = text.match(
		/^(?:(\d+(?:\.\d+)?)\s*h(?:ours?)?)?\s*(?:(\d+(?:\.\d+)?)\s*m(?:in(?:utes?)?)?)?\s*(?:(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?)?$/i,
	);
	if (minSecMatch && (minSecMatch[1] || minSecMatch[2] || minSecMatch[3])) {
		const hours = minSecMatch[1] ? Number.parseFloat(minSecMatch[1]) : 0;
		const minutes = minSecMatch[2] ? Number.parseFloat(minSecMatch[2]) : 0;
		const seconds = minSecMatch[3] ? Number.parseFloat(minSecMatch[3]) : 0;
		return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
	}
	const msMatch = text.match(/^(\d+(?:\.\d+)?)\s*ms$/i);
	if (msMatch) {
		return Math.round(Number.parseFloat(msMatch[1].replace(/[,_]/g, "")));
	}
	const secMatch = text.match(/^(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?$/i);
	if (secMatch) {
		return Math.round(Number.parseFloat(secMatch[1].replace(/[,_]/g, "")) * 1000);
	}
	const clockMatch = text.match(/^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
	if (clockMatch) {
		const hours = clockMatch[1] ? Number.parseInt(clockMatch[1], 10) : 0;
		const minutes = Number.parseInt(clockMatch[2], 10);
		const seconds = Number.parseFloat(clockMatch[3]);
		return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
	}
	const cleanNum = text.replace(/[,_]/g, "");
	const num = Number.parseFloat(cleanNum);
	if (Number.isFinite(num)) {
		return Math.round(num);
	}
	return 0;
}

function parseCost(raw: string): number {
	const cleaned = raw.replace(/[$,\s]|usd/gi, "");
	const num = Number.parseFloat(cleaned);
	return Number.isFinite(num) ? num : 0;
}

function parseTokenCount(raw: string): number {
	const cleaned = raw.replace(/[,_\s]/g, "");
	const kMatch = cleaned.match(/^(\d+(?:\.\d+)?)[kK]$/);
	if (kMatch) {
		return Math.round(Number.parseFloat(kMatch[1]) * 1000);
	}
	const mMatch = cleaned.match(/^(\d+(?:\.\d+)?)[mM]$/);
	if (mMatch) {
		return Math.round(Number.parseFloat(mMatch[1]) * 1_000_000);
	}
	const num = Number.parseFloat(cleaned);
	return Number.isFinite(num) ? Math.round(num) : 0;
}

function classifyMetricKey(
	rawKey: string,
): "totalTokens" | "inputTokens" | "outputTokens" | "cacheReadTokens" | "totalCost" | "durationMs" | null {
	const k = rawKey.trim().toLowerCase().replace(/[-_]/g, " ");
	if (k.includes("cache read") || k.includes("cached token") || k === "cachereadtokens" || k === "prompt cache read") {
		return "cacheReadTokens";
	}
	if (
		k.includes("input token") ||
		k.includes("prompt token") ||
		k === "inputtokens" ||
		k === "prompttokens" ||
		k === "input" ||
		k === "prompt"
	) {
		return "inputTokens";
	}
	if (
		k.includes("output token") ||
		k.includes("completion token") ||
		k === "outputtokens" ||
		k === "completiontokens" ||
		k === "output" ||
		k === "completion"
	) {
		return "outputTokens";
	}
	if (
		k.includes("total token") ||
		k === "totaltokens" ||
		k === "tokens total" ||
		k === "tokens" ||
		k === "token count"
	) {
		return "totalTokens";
	}
	if (k.includes("cost") || k === "totalcost" || k === "estimated cost" || k === "total cost") {
		return "totalCost";
	}
	if (
		k.includes("duration") ||
		k.includes("execution time") ||
		k.includes("elapsed time") ||
		k === "elapsed" ||
		k === "durationms" ||
		k === "time"
	) {
		return "durationMs";
	}
	return null;
}

interface ParsedMetricsEntry {
	totalTokens?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	totalCost?: number;
	durationMs?: number;
	detected: boolean;
}

function parseMetricsFromContent(content: string): TeamworkPerformanceMetrics[] {
	const results: TeamworkPerformanceMetrics[] = [];

	// 1. JSON Code blocks
	const jsonMatches = content.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/g);
	for (const match of jsonMatches) {
		try {
			const parsed: unknown = JSON.parse(match[1]);
			if (typeof parsed === "object" && parsed !== null) {
				const obj = parsed as Record<string, unknown>;
				const usage =
					typeof obj.usage === "object" && obj.usage !== null ? (obj.usage as Record<string, unknown>) : obj;
				let found = false;
				let inTokens = 0;
				let outTokens = 0;
				let cacheTokens = 0;
				let totTokens = 0;
				let cost = 0;
				let dur = 0;

				for (const [key, val] of Object.entries(usage)) {
					const classified = classifyMetricKey(key);
					if (classified) {
						found = true;
						const strVal = String(val);
						if (classified === "inputTokens") inTokens = parseTokenCount(strVal);
						else if (classified === "outputTokens") outTokens = parseTokenCount(strVal);
						else if (classified === "cacheReadTokens") cacheTokens = parseTokenCount(strVal);
						else if (classified === "totalTokens") totTokens = parseTokenCount(strVal);
						else if (classified === "totalCost") cost = parseCost(strVal);
						else if (classified === "durationMs") dur = parseDurationMs(strVal);
					}
				}
				if (usage !== obj) {
					if (obj.cost !== undefined || obj.totalCost !== undefined) {
						cost = parseCost(String(obj.totalCost ?? obj.cost));
						found = true;
					}
					if (obj.duration !== undefined || obj.durationMs !== undefined || obj.executionTime !== undefined) {
						dur = parseDurationMs(String(obj.durationMs ?? obj.duration ?? obj.executionTime));
						found = true;
					}
				}

				if (found) {
					if (totTokens === 0 && (inTokens > 0 || outTokens > 0 || cacheTokens > 0)) {
						totTokens = inTokens + outTokens + cacheTokens;
					}
					results.push({
						totalTokens: totTokens,
						inputTokens: inTokens,
						outputTokens: outTokens,
						cacheReadTokens: cacheTokens,
						totalCost: cost,
						durationMs: dur,
					});
				}
			}
		} catch {
			// ignore non-json
		}
	}

	// 2. Markdown Tables
	const lines = content.split("\n");
	let inMultiColumnTable = false;
	let colMap: {
		agent?: number;
		input?: number;
		output?: number;
		cache?: number;
		total?: number;
		cost?: number;
		duration?: number;
	} | null = null;
	const tableRows: TeamworkPerformanceMetrics[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line.startsWith("|") || !line.endsWith("|")) {
			inMultiColumnTable = false;
			colMap = null;
			continue;
		}

		const cells = line
			.slice(1, -1)
			.split(/(?<!\\)\|/)
			.map(c => c.replace(/\\\|/g, "|").trim());

		const nextLine = i + 1 < lines.length ? lines[i + 1].trim() : "";
		const nextIsSeparator =
			nextLine.startsWith("|") &&
			nextLine.endsWith("|") &&
			nextLine
				.slice(1, -1)
				.split(/(?<!\\)\|/)
				.every(c => /^[-:\s]+$/.test(c.trim()));

		const hasMetricHeader =
			nextIsSeparator &&
			cells.some(c => {
				const clean = cleanMarkdown(c).toLowerCase();
				return (
					clean.includes("token") ||
					clean.includes("cost") ||
					clean.includes("duration") ||
					clean.includes("execution time")
				);
			});
		if (hasMetricHeader && cells.length >= 2) {
			const cleanedCells = cells.map(c => cleanMarkdown(c).toLowerCase());
			const inIdx = cleanedCells.findIndex(c => c.includes("input") || c.includes("prompt"));
			const outIdx = cleanedCells.findIndex(c => c.includes("output") || c.includes("completion"));
			const cacheIdx = cleanedCells.findIndex(c => c.includes("cache"));
			const totIdx = cleanedCells.findIndex(c => c.includes("total token") || c === "tokens" || c === "total");
			const costIdx = cleanedCells.findIndex(c => c.includes("cost"));
			const durIdx = cleanedCells.findIndex(
				c => c.includes("duration") || c.includes("time") || c.includes("elapsed"),
			);
			const agentIdx = cleanedCells.findIndex(
				c => c.includes("agent") || c.includes("role") || c.includes("worker") || c.includes("cohort"),
			);

			if (inIdx !== -1 || outIdx !== -1 || totIdx !== -1 || costIdx !== -1 || durIdx !== -1) {
				inMultiColumnTable = true;
				colMap = {
					agent: agentIdx !== -1 ? agentIdx : undefined,
					input: inIdx !== -1 ? inIdx : undefined,
					output: outIdx !== -1 ? outIdx : undefined,
					cache: cacheIdx !== -1 ? cacheIdx : undefined,
					total: totIdx !== -1 ? totIdx : undefined,
					cost: costIdx !== -1 ? costIdx : undefined,
					duration: durIdx !== -1 ? durIdx : undefined,
				};
				continue;
			}
		}

		if (inMultiColumnTable && colMap) {
			if (cells.every(c => /^[-:\s]+$/.test(c))) {
				continue;
			}

			const firstCell = cleanMarkdown(cells[0]).toLowerCase();
			const isTotalRow =
				firstCell === "total" || firstCell === "sum" || firstCell === "summary" || firstCell === "all";
			if (isTotalRow && tableRows.length > 0) {
				continue;
			}

			let inTokens = 0;
			let outTokens = 0;
			let cacheTokens = 0;
			let totTokens = 0;
			let cost = 0;
			let dur = 0;
			let hasAny = false;

			if (colMap.input !== undefined && colMap.input < cells.length) {
				inTokens = parseTokenCount(cleanMarkdown(cells[colMap.input]));
				hasAny = true;
			}
			if (colMap.output !== undefined && colMap.output < cells.length) {
				outTokens = parseTokenCount(cleanMarkdown(cells[colMap.output]));
				hasAny = true;
			}
			if (colMap.cache !== undefined && colMap.cache < cells.length) {
				cacheTokens = parseTokenCount(cleanMarkdown(cells[colMap.cache]));
				hasAny = true;
			}
			if (colMap.total !== undefined && colMap.total < cells.length) {
				totTokens = parseTokenCount(cleanMarkdown(cells[colMap.total]));
				hasAny = true;
			}
			if (colMap.cost !== undefined && colMap.cost < cells.length) {
				cost = parseCost(cleanMarkdown(cells[colMap.cost]));
				hasAny = true;
			}
			if (colMap.duration !== undefined && colMap.duration < cells.length) {
				dur = parseDurationMs(cleanMarkdown(cells[colMap.duration]));
				hasAny = true;
			}

			if (hasAny) {
				if (totTokens === 0 && (inTokens > 0 || outTokens > 0 || cacheTokens > 0)) {
					totTokens = inTokens + outTokens + cacheTokens;
				}
				tableRows.push({
					totalTokens: totTokens,
					inputTokens: inTokens,
					outputTokens: outTokens,
					cacheReadTokens: cacheTokens,
					totalCost: cost,
					durationMs: dur,
				});
			}
		}
	}

	if (tableRows.length > 0) {
		results.push(...tableRows);
		return results;
	}

	// 3. Bullet points, Key-Value Lines, and 2-Column Metric-Value Tables
	const nonCodeText = content.replace(/```[\s\S]*?```/g, "");
	const textLines = nonCodeText.split("\n");

	let current: ParsedMetricsEntry = { detected: false };

	const pushCurrent = () => {
		if (
			current.detected ||
			(current.totalTokens ?? 0) > 0 ||
			(current.inputTokens ?? 0) > 0 ||
			(current.outputTokens ?? 0) > 0 ||
			(current.cacheReadTokens ?? 0) > 0 ||
			(current.totalCost ?? 0) > 0 ||
			(current.durationMs ?? 0) > 0
		) {
			let tot = current.totalTokens ?? 0;
			const inp = current.inputTokens ?? 0;
			const out = current.outputTokens ?? 0;
			const cache = current.cacheReadTokens ?? 0;
			if (tot === 0 && (inp > 0 || out > 0 || cache > 0)) {
				tot = inp + out + cache;
			}
			results.push({
				totalTokens: tot,
				inputTokens: inp,
				outputTokens: out,
				cacheReadTokens: cache,
				totalCost: current.totalCost ?? 0,
				durationMs: current.durationMs ?? 0,
			});
			current = { detected: false };
		}
	};

	for (const line of textLines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		if (/^#{1,6}\s+/.test(trimmed)) {
			pushCurrent();
			continue;
		}

		if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
			const cells = trimmed
				.slice(1, -1)
				.split(/(?<!\\)\|/)
				.map(c => c.replace(/\\\|/g, "|").trim());

			if (cells.length === 2 && !cells.every(c => /^[-:\s]+$/.test(c))) {
				const rawKey = cleanMarkdown(cells[0]);
				const rawVal = cleanMarkdown(cells[1]);
				const classified = classifyMetricKey(rawKey);
				if (classified) {
					if (current[classified] !== undefined) {
						pushCurrent();
					}
					current.detected = true;
					if (classified === "inputTokens") current.inputTokens = parseTokenCount(rawVal);
					else if (classified === "outputTokens") current.outputTokens = parseTokenCount(rawVal);
					else if (classified === "cacheReadTokens") current.cacheReadTokens = parseTokenCount(rawVal);
					else if (classified === "totalTokens") current.totalTokens = parseTokenCount(rawVal);
					else if (classified === "totalCost") current.totalCost = parseCost(rawVal);
					else if (classified === "durationMs") current.durationMs = parseDurationMs(rawVal);
					continue;
				}
			}
		}

		const kvMatch = trimmed.match(
			/^(?:[-*+]\s+|\d+\.\s+)?(?:[*_`#\s]*)([^:\n\r=_]+?)(?:[*_`\s]*)\s*[:=]\s*[*_`\s]*([^\n\r`*]+?)(?:[*_`\s]*)$/,
		);
		if (kvMatch) {
			const rawKey = cleanMarkdown(kvMatch[1]);
			const rawVal = cleanMarkdown(kvMatch[2]);
			const classified = classifyMetricKey(rawKey);
			if (classified) {
				if (current[classified] !== undefined) {
					pushCurrent();
				}
				current.detected = true;
				if (classified === "inputTokens") current.inputTokens = parseTokenCount(rawVal);
				else if (classified === "outputTokens") current.outputTokens = parseTokenCount(rawVal);
				else if (classified === "cacheReadTokens") current.cacheReadTokens = parseTokenCount(rawVal);
				else if (classified === "totalTokens") current.totalTokens = parseTokenCount(rawVal);
				else if (classified === "totalCost") current.totalCost = parseCost(rawVal);
				else if (classified === "durationMs") current.durationMs = parseDurationMs(rawVal);
				continue;
			}
		}

		const inlineIn =
			trimmed.match(/([0-9.,_]+[kKmM]?)\s*(?:input|prompt)\s*tokens?/i) ??
			trimmed.match(/(?:input|prompt)\s*tokens?\s*[:=]\s*([0-9.,_]+[kKmM]?)/i);
		const inlineOut =
			trimmed.match(/([0-9.,_]+[kKmM]?)\s*(?:output|completion)\s*tokens?/i) ??
			trimmed.match(/(?:output|completion)\s*tokens?\s*[:=]\s*([0-9.,_]+[kKmM]?)/i);
		const inlineCache =
			trimmed.match(/([0-9.,_]+[kKmM]?)\s*(?:cache\s*read|cached)\s*tokens?/i) ??
			trimmed.match(/(?:cache\s*read|cached)\s*tokens?\s*[:=]\s*([0-9.,_]+[kKmM]?)/i);
		const inlineTot =
			trimmed.match(/([0-9.,_]+[kKmM]?)\s*total\s*tokens?/i) ??
			trimmed.match(/(?:total\s*tokens?|totalTokens)\s*[:=]\s*([0-9.,_]+[kKmM]?)/i);

		if (inlineIn || inlineOut || inlineCache || inlineTot) {
			current.detected = true;
			if (inlineIn) current.inputTokens = parseTokenCount(inlineIn[1]);
			if (inlineOut) current.outputTokens = parseTokenCount(inlineOut[1]);
			if (inlineCache) current.cacheReadTokens = parseTokenCount(inlineCache[1]);
			if (inlineTot) current.totalTokens = parseTokenCount(inlineTot[1]);
		}
	}

	pushCurrent();
	return results;
}

function formatCost(cost: number): string {
	if (cost === 0) return "$0.00";
	if (cost < 0.01) {
		return `$${cost.toFixed(4)}`;
	}
	const formatted = cost.toFixed(4);
	const trimmed = formatted.replace(/(\.\d{2}[1-9]?)0+$/, "$1").replace(/(\.\d{2})0+$/, "$1");
	return `$${trimmed}`;
}

function formatDuration(ms: number): string {
	if (ms <= 0) return "0s (0ms)";
	if (ms < 1000) return `${ms}ms`;
	const totalSec = ms / 1000;
	if (totalSec < 60) {
		const s = totalSec % 1 === 0 ? totalSec.toFixed(0) : totalSec.toFixed(2).replace(/\.?0+$/, "");
		return `${s}s (${ms}ms)`;
	}
	const minutes = Math.floor(totalSec / 60);
	const seconds = totalSec % 60;
	const s = seconds % 1 === 0 ? seconds.toFixed(0) : seconds.toFixed(1).replace(/\.?0+$/, "");
	return `${minutes}m ${s}s (${ms}ms)`;
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

	agents.sort((a, b) => {
		const aIdx = getAgentOrderIndex(a.name);
		const bIdx = getAgentOrderIndex(b.name);
		if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
		if (aIdx !== -1) return -1;
		if (bIdx !== -1) return 1;
		return a.name.localeCompare(b.name);
	});

	// 6. Token & Performance Metrics
	const subagentMetrics = new Map<string, TeamworkPerformanceMetrics>();
	let metricsDetected = false;

	for (const agent of agents) {
		const candidateFiles: string[] = [];
		if (agent.handoffPath) {
			candidateFiles.push(agent.handoffPath);
		}
		for (const f of agent.files) {
			if (f.endsWith(".md") && f !== "handoff.md") {
				candidateFiles.push(path.join(agentDir, agent.name, f));
			}
		}

		for (const filePath of candidateFiles) {
			const text = await readFileSafe(filePath);
			if (!text) continue;
			const parsed = parseMetricsFromContent(text);
			if (parsed.length > 0) {
				metricsDetected = true;
				const existing = subagentMetrics.get(agent.name) ?? {
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0,
					durationMs: 0,
				};
				for (const item of parsed) {
					existing.totalTokens += item.totalTokens;
					existing.inputTokens += item.inputTokens;
					existing.outputTokens += item.outputTokens;
					existing.cacheReadTokens += item.cacheReadTokens;
					existing.totalCost += item.totalCost;
					existing.durationMs += item.durationMs;
				}
				subagentMetrics.set(agent.name, existing);
				break;
			}
		}
	}

	const coordinationFiles: string[] = [
		path.join(agentDir, "handoff.md"),
		path.join(agentDir, "progress.md"),
		path.join(agentDir, "TeamworkOrchestrator", "progress.md"),
		path.join(agentDir, "plan.md"),
		path.join(agentDir, "TeamworkOrchestrator", "plan.md"),
		path.join(agentDir, "GATE_STATUS.md"),
		path.join(agentDir, "TeamworkOrchestrator", "GATE_STATUS.md"),
		path.join(agentDir, "victory_report.md"),
		path.join(agentDir, "audit_report.md"),
		path.join(agentDir, "token_usage.md"),
		path.join(agentDir, "metrics.md"),
		path.join(agentDir, "performance.md"),
	];

	const coordinationMetrics: TeamworkPerformanceMetrics[] = [];
	const seenCoordination = new Set<string>();

	for (const candidate of coordinationFiles) {
		if (seenCoordination.has(candidate)) continue;
		seenCoordination.add(candidate);

		const text = await readFileSafe(candidate);
		if (!text) continue;

		const parsed = parseMetricsFromContent(text);
		if (parsed.length > 0) {
			metricsDetected = true;
			if (subagentMetrics.size === 0) {
				coordinationMetrics.push(...parsed);
			}
		}
	}

	let totalTokens = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let totalCost = 0;
	let durationMs = 0;

	for (const m of subagentMetrics.values()) {
		totalTokens += m.totalTokens;
		inputTokens += m.inputTokens;
		outputTokens += m.outputTokens;
		cacheReadTokens += m.cacheReadTokens;
		totalCost += m.totalCost;
		durationMs += m.durationMs;
	}
	for (const m of coordinationMetrics) {
		totalTokens += m.totalTokens;
		inputTokens += m.inputTokens;
		outputTokens += m.outputTokens;
		cacheReadTokens += m.cacheReadTokens;
		totalCost += m.totalCost;
		durationMs += m.durationMs;
	}

	if (totalTokens === 0 && (inputTokens > 0 || outputTokens > 0 || cacheReadTokens > 0)) {
		totalTokens = inputTokens + outputTokens + cacheReadTokens;
	}

	let metrics: TeamworkPerformanceMetrics | undefined;
	if (metricsDetected || totalTokens > 0 || totalCost > 0 || durationMs > 0) {
		metrics = {
			totalTokens,
			inputTokens,
			outputTokens,
			cacheReadTokens,
			totalCost: Number.parseFloat(totalCost.toFixed(6)),
			durationMs,
		};
	}

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
		metrics,
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
		status.agents.length === 0 &&
		!status.metrics;
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

	// 6. Performance & Token Metrics
	if (status.metrics) {
		lines.push("");
		lines.push(subHr("PERFORMANCE & TOKEN METRICS"));
		lines.push(`Total Tokens:       ${status.metrics.totalTokens.toLocaleString("en-US")}`);
		lines.push(`Input Tokens:       ${status.metrics.inputTokens.toLocaleString("en-US")}`);
		lines.push(`Output Tokens:      ${status.metrics.outputTokens.toLocaleString("en-US")}`);
		lines.push(`Cache Read Tokens:  ${status.metrics.cacheReadTokens.toLocaleString("en-US")}`);
		lines.push(`Total Cost:         ${formatCost(status.metrics.totalCost)}`);
		lines.push(`Duration:           ${formatDuration(status.metrics.durationMs)}`);
	}

	lines.push(hr);
	const output = lines.join("\n");
	const MAX_OUTPUT_LENGTH = 65536;
	if (output.length > MAX_OUTPUT_LENGTH) {
		return `${output.slice(0, MAX_OUTPUT_LENGTH)}\n\n[Output truncated at 64KB to prevent display freeze]\n${hr}`;
	}
	return output;
}
