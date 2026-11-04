/**
 * Sibling & coordinator transcript forking (`forkFrom`) for `task` subagents
 * (Google Antigravity v1.5.0 `native_swarm` `fork: "<member>" | "coordinator"` parity).
 *
 * Unlike `seance` (which opens an arbitrary historical session in read-only
 * consult mode), `forkFrom` branches a live or completed member of the CURRENT
 * session tree so a newly spawned worker inherits that member's conversation
 * context while keeping its own full write/edit/bash/IRC toolset and model.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, prompt } from "@oh-my-pi/pi-utils";
import subagentForkContextTemplate from "../prompts/system/subagent-fork-context.md" with { type: "text" };
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { ensurePersistedRoster, sessionFileBelongsToRoot } from "../registry/persisted-agents";
import { loadSessionFile } from "../session/session-loader";
import { FileSessionStorage } from "../session/session-storage";
import type { ToolSession } from "../tools";
import { isBundledSeance } from "./seance";
import type { AgentDefinition } from "./types";

export interface PreparedForkSession {
	sourceFile: string;
	fromLabel: string;
	promptSuffix: (childId: string) => string;
}

const COORDINATOR_SELECTORS = new Set(["coordinator", "main", "parent"]);

async function flushIfInProcessSession(candidate: unknown): Promise<void> {
	if (!candidate || typeof candidate !== "object") return;
	if ("flushSessionTranscript" in candidate && typeof candidate.flushSessionTranscript === "function") {
		await candidate.flushSessionTranscript();
		return;
	}
	if ("sessionManager" in candidate && candidate.sessionManager && typeof candidate.sessionManager === "object") {
		const manager = candidate.sessionManager;
		if ("ensureOnDisk" in manager && typeof manager.ensureOnDisk === "function") {
			await manager.ensureOnDisk();
		}
		if ("flush" in manager && typeof manager.flush === "function") {
			await manager.flush();
		}
	}
}

async function verifySessionJsonl(filePath: string): Promise<void> {
	let stat;
	try {
		stat = await fs.stat(filePath);
	} catch (error) {
		if (isEnoent(error)) {
			throw new Error(`Transcript file for forkFrom target does not exist on disk yet: ${path.basename(filePath)}`);
		}
		throw error;
	}
	if (!stat.isFile()) {
		throw new Error(`Transcript path for forkFrom target is not a regular file: ${path.basename(filePath)}`);
	}
	const loaded = await loadSessionFile(filePath, new FileSessionStorage(), { throwIfMissing: true });
	const header = loaded.entries[0];
	if (loaded.invalidHeader || !header || header.type !== "session" || !header.id) {
		throw new Error(`Transcript for forkFrom target does not have a valid session header.`);
	}
}

export async function prepareForkFromSession(options: {
	session: ToolSession;
	forkFrom: string;
	agent: AgentDefinition;
	planMode: boolean;
	hasSourceSession: boolean;
}): Promise<PreparedForkSession> {
	const { session, agent, planMode, hasSourceSession } = options;
	const target = options.forkFrom.trim();
	if (!target) {
		throw new Error('`forkFrom` requires a non-empty roster agent name or "coordinator".');
	}
	if (planMode) {
		throw new Error("`forkFrom` is unavailable in plan mode.");
	}
	if (hasSourceSession || isBundledSeance(agent)) {
		throw new Error("`forkFrom` cannot be combined with `seance` or `sourceSession`.");
	}

	const registry = session.agentRegistry ?? AgentRegistry.global();
	const parentSessionFile = session.getSessionFile();

	let sourceFile: string | null = null;
	let fromLabel = target;

	if (COORDINATOR_SELECTORS.has(target.toLowerCase()) || target === MAIN_AGENT_ID) {
		const mainRef = registry.get(session.getAgentId?.() ?? MAIN_AGENT_ID) ?? registry.get(MAIN_AGENT_ID);
		await flushIfInProcessSession(mainRef?.session);
		sourceFile = parentSessionFile ?? mainRef?.sessionFile ?? null;
		if (!sourceFile) {
			throw new Error('`forkFrom: "coordinator"` requires a persisted parent session.');
		}
		fromLabel = "coordinator";
	} else {
		if (parentSessionFile) {
			const existing = registry.get(target);
			if (!existing || !existing.sessionFile) {
				await ensurePersistedRoster(registry, parentSessionFile);
			}
		}
		const exact = registry.get(target);
		const match =
			exact && exact.kind !== "advisor"
				? exact
				: registry
						.list()
						.find(
							candidate => candidate.kind !== "advisor" && candidate.id.toLowerCase() === target.toLowerCase(),
						);

		if (match) {
			await flushIfInProcessSession(match.session);
			sourceFile = match.sessionFile;
			fromLabel = match.id;
		} else if (/^[A-Za-z0-9._-]+$/.test(target)) {
			const artifactsDir =
				session.getArtifactsDir?.() ??
				(parentSessionFile?.endsWith(".jsonl") ? parentSessionFile.slice(0, -6) : null);
			if (artifactsDir) {
				const candidateFile = path.join(artifactsDir, `${target}.jsonl`);
				try {
					if ((await fs.stat(candidateFile)).isFile()) {
						sourceFile = candidateFile;
						fromLabel = target;
					}
				} catch {
					// Fall through to structured error below.
				}
			}
		}

		if (!sourceFile) {
			const available = registry
				.list()
				.filter(ref => ref.kind !== "advisor")
				.map(ref => ref.id);
			throw new Error(
				`Cannot forkFrom unknown or unpersisted agent "${target}".${available.length > 0 ? ` Known peers: ${available.join(", ")}` : ""}`,
			);
		}

		if (parentSessionFile && !sessionFileBelongsToRoot(sourceFile, parentSessionFile)) {
			throw new Error(`Cannot forkFrom "${target}": transcript belongs to a different session tree.`);
		}
	}

	await verifySessionJsonl(sourceFile);

	return {
		sourceFile,
		fromLabel,
		promptSuffix: (childId: string) => prompt.render(subagentForkContextTemplate, { fromLabel, childId }).trim(),
	};
}
