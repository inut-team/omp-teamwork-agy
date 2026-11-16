import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import boardNoticeTemplate from "../prompts/swarm/board-notice.md" with { type: "text" };
import workerBriefingTemplate from "../prompts/swarm/worker-briefing.md" with { type: "text" };
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry, type AgentRegistryApi, MAIN_AGENT_ID } from "../registry/agent-registry";
import { resolveEffectiveSubagentPolicy, runStructuredSubagent } from "../task/structured-subagent";
import { createSubagentSettings } from "../task/executor";
import type { ToolSession } from "../tools";
import { isSwarmQuotaError, SwarmHub } from "./hub";
import {
	countsAsUnread,
	effectiveChannels,
	effectiveRole,
	homeChannelIn,
	isRoleObserver,
	mentionsIn,
	messageChannelOf,
	seesIn,
	SWARM_ALL_CHANNELS,
	SWARM_MAIN_CHANNEL,
	validateChannelName,
	validateWorkerName,
} from "./mentions";
import { SwarmBoardStore } from "./store";
import type {
	SwarmBoardMessage,
	SwarmChannelInfo,
	SwarmMemberRecord,
	SwarmMemberStatus,
	SwarmOverviewView,
	SwarmRole,
	SwarmRosterFile,
	SwarmWakeMode,
	SwarmWorkspaceMode,
} from "./types";

export const SWARM_TOOL_NAMES = ["swarm", "post_message", "read_board", "swarm_wait"] as const;

interface ActiveWorkerRun {
	memberName: string;
	agentId: string;
	abortController: AbortController;
	running: boolean;
}

/** Resolve the shared swarm directory (`SWARM_DIR`) for any session in the tree (coordinator or nested worker). */
export function resolveSwarmDir(
	session: Pick<
		ToolSession,
		"cwd" | "getArtifactsDir" | "getSessionFile" | "getSessionId" | "localProtocolOptions" | "swarmContext"
	>,
): string {
	if (session.swarmContext?.swarmDir) {
		return path.resolve(session.swarmContext.swarmDir);
	}
	const rootArtifactsDir =
		session.localProtocolOptions?.getArtifactsDir?.() ??
		session.getArtifactsDir?.() ??
		(session.getSessionFile()?.endsWith(".jsonl") ? session.getSessionFile()!.slice(0, -6) : null);
	if (rootArtifactsDir) {
		return path.join(rootArtifactsDir, "swarm");
	}
	const rootId = session.localProtocolOptions?.getSessionId?.() ?? session.getSessionId?.() ?? "default";
	return path.join(session.cwd, ".omp", "swarm", rootId);
}

/** Resolve the swarm directory from an InteractiveMode / CLI cwd + optional session artifacts dir. */
export function resolveSwarmDirFromContext(options: {
	cwd: string;
	artifactsDir?: string | null;
	sessionFile?: string | null;
	sessionId?: string | null;
}): string {
	if (options.artifactsDir) return path.join(options.artifactsDir, "swarm");
	if (options.sessionFile?.endsWith(".jsonl")) return path.join(options.sessionFile.slice(0, -6), "swarm");
	return path.join(options.cwd, ".omp", "swarm", options.sessionId ?? "default");
}

/** Promote `swarm`, `post_message`, `read_board`, and `swarm_wait` out of `xd://` onto the active tool set when possible. */
export async function promoteSwarmToolsOnSession(session: ToolSession): Promise<void> {
	if (session.xdev) {
		for (const name of SWARM_TOOL_NAMES) {
			session.xdev.mountedNames.delete(name);
		}
	}
	if (session.setActiveToolNames && session.toolRegistry) {
		const active = new Set<string>();
		for (const name of session.toolRegistry.keys()) {
			if (session.isToolActive?.(name) || (SWARM_TOOL_NAMES as readonly string[]).includes(name)) {
				active.add(name);
			}
		}
		session.setActiveToolNames(active);
	}
	await session.promoteSwarmTools?.();
}

function formatModelLabel(model: Model | undefined, fallback?: string): string {
	if (model) return `${model.provider}/${model.id}`;
	return fallback?.trim() || "default";
}

function relativeAge(isoTime?: string): string {
	if (!isoTime) return "never";
	const deltaMs = Date.now() - Date.parse(isoTime);
	if (!Number.isFinite(deltaMs) || deltaMs < 60_000) return "just now";
	const mins = Math.floor(deltaMs / 60_000);
	if (mins < 60) return `${mins} min ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours} h ago`;
	return `${Math.floor(hours / 24)} days ago`;
}

async function directoryExists(targetPath: string): Promise<boolean> {
	try {
		const st = await fs.stat(targetPath);
		return st.isDirectory();
	} catch {
		return false;
	}
}

/**
 * Thread-aware Swarm Runtime facade per `swarmDir`.
 *
 * Delegates all shared state, board locking, parking, waiters, and wake routing
 * through `SwarmHub.global()`, so coordinator sessions on main and worker/subagent
 * sessions on Bun worker threads share one authoritative runtime.
 */
export class SwarmRuntime {
	static readonly #instances = new Map<string, SwarmRuntime>();

	static forSession(session: ToolSession): SwarmRuntime {
		return SwarmRuntime.forDir(resolveSwarmDir(session));
	}

	static forDir(swarmDir: string): SwarmRuntime {
		const resolved = path.resolve(swarmDir);
		let inst = SwarmRuntime.#instances.get(resolved);
		if (!inst) {
			inst = new SwarmRuntime(resolved);
			SwarmRuntime.#instances.set(resolved, inst);
		}
		return inst;
	}

	static resetForTests(): void {
		for (const inst of SwarmRuntime.#instances.values()) {
			inst.#disposeForTests();
		}
		SwarmRuntime.#instances.clear();
		SwarmHub.resetGlobalForTests();
	}

	readonly dir: string;
	readonly #activeRuns = new Map<string, ActiveWorkerRun>();

	constructor(swarmDir: string) {
		this.dir = path.resolve(swarmDir);
	}

	/** Local board store handle (for metadata inspection and main-thread test utilities). */
	get store(): SwarmBoardStore {
		return SwarmBoardStore.forDir(this.dir);
	}

	#disposeForTests(): void {
		for (const run of this.#activeRuns.values()) {
			run.abortController.abort("test reset");
		}
		this.#activeRuns.clear();
	}

	/** True while `memberName` is actively parked in `swarm_wait`. */
	isParked(memberName: string): Promise<boolean> {
		return SwarmHub.global().isParked(this.dir, memberName);
	}

	/** Resolves once `memberName` enters `swarm_wait` (or immediately if already parked). */
	waitUntilParked(memberName: string): Promise<void> {
		return SwarmHub.global().waitUntilParked(this.dir, memberName);
	}

	/** Bind a registry `agentId` to its canonical swarm `memberName`. */
	registerAgentBinding(agentId: string, memberName: string): void {
		SwarmHub.global().registerAgentBinding(this.dir, agentId, memberName);
	}

	/** Resolve which swarm member `session` represents (`"coordinator"` at depth 0, else worker roster name). */
	resolveActorName(session: ToolSession, roster: SwarmRosterFile | null): string {
		if (session.swarmContext?.memberName) {
			return session.swarmContext.memberName;
		}
		const agentId = session.getAgentId?.() ?? MAIN_AGENT_ID;
		if ((session.taskDepth ?? 0) === 0 || agentId === MAIN_AGENT_ID) {
			return "coordinator";
		}
		if (roster) {
			if (roster.members[agentId]) return agentId;
			for (const member of Object.values(roster.members)) {
				if (member.agent_id === agentId || agentId.endsWith(`.${member.name}`)) {
					return member.name;
				}
			}
		}
		return agentId;
	}

	/** Compute a member's live status (`killed` | `waiting` | `working` | `stopped`) matching `board.StateOf`. */
	memberStatusOf(member: SwarmMemberRecord): SwarmMemberStatus {
		if (member.killed) return "killed";
		const status = SwarmHub.global().getMemberStatus(this.dir, member);
		if (status === "stopped") {
			const localRun = this.#activeRuns.get(member.name);
			if (localRun?.running) return "working";
		}
		return status;
	}

	/** Ensure the swarm is initialized on disk for `session` when the coordinator starts it. */
	async ensureCoordinatorSwarm(session: ToolSession, title?: string): Promise<SwarmRosterFile> {
		const coordinatorAgentId =
			(session.taskDepth ?? 0) === 0 ? (session.getAgentId?.() ?? MAIN_AGENT_ID) : MAIN_AGENT_ID;
		const coordinatorConvId =
			session.localProtocolOptions?.getSessionId?.() ?? session.getSessionId?.() ?? "coordinator";
		const activeModel = formatModelLabel(
			session.getActiveModel?.(),
			session.getActiveModelString?.() ?? session.getModelString?.(),
		);
		const roster = await SwarmHub.global().ensureCoordinatorSwarm(this.dir, {
			coordinatorAgentId,
			coordinatorConversationId: coordinatorConvId,
			model: activeModel,
			title,
		});
		session.setSwarmContext?.({ swarmDir: this.dir, memberName: "coordinator" });
		return roster;
	}

	/** Post a message and trigger the Wake Engine (`ring`). */
	async postAndRing(params: {
		session: ToolSession;
		text: string;
		channel?: string;
	}): Promise<{ actor: string; message: SwarmBoardMessage; warnings: string[] }> {
		const snap = await SwarmHub.global().getSnapshot(this.dir);
		if (!snap.roster) {
			throw new Error("no swarm yet; add a worker to start one");
		}
		const actor = this.resolveActorName(params.session, snap.roster);
		const senderAgentId = params.session.getAgentId?.() ?? snap.roster.members[actor]?.agent_id ?? MAIN_AGENT_ID;
		const { message, warnings } = await SwarmHub.global().postMessage(this.dir, {
			actor,
			text: params.text,
			channel: params.channel,
			senderAgentId,
		});
		return { actor, message, warnings };
	}

	/** Check if any concerning messages already arrived after `since` for `memberName` (`WaitCheck` / `HasConcerning`). */
	async findConcerningAfter(params: {
		memberName: string;
		since: number;
		mentionsOnly: boolean;
	}): Promise<{ head: number; matching: SwarmBoardMessage[]; lastReadSeq: number }> {
		const snap = await SwarmHub.global().getSnapshot(this.dir);
		if (!snap.roster) return { head: 0, matching: [], lastReadSeq: 0 };
		const member = snap.roster.members[params.memberName];
		const channelMap = new Map<string, SwarmChannelInfo>(snap.roster.channels.map(c => [c.name, c]));
		const isActiveChannel = (ch: string) => {
			const info = channelMap.get(ch);
			return Boolean(info && !info.archived);
		};
		const memberSet = member ? effectiveChannels(member.role, member.channels, member.name) : [SWARM_ALL_CHANNELS];

		const matching = snap.messages.filter(msg => {
			if (msg.seq <= params.since || msg.agent === params.memberName) return false;
			if (!params.mentionsOnly) {
				return seesIn(params.memberName, memberSet, msg, isActiveChannel) && countsAsUnread(msg);
			}
			return mentionsIn(msg.text, params.memberName, memberSet, isActiveChannel);
		});

		return {
			head: snap.head,
			matching,
			lastReadSeq: member?.last_read_seq ?? 0,
		};
	}

	/**
	 * Sleep / park in `swarm_wait`:
	 * - Workers / observers inside an `AgentSession` (`parkOnSwarmWait`) atomically record wait + return `{ parked: true }`,
	 *   terminating the current LLM turn at zero token cost (`TERMINAL_TOOL_RESULT_ABORT_REASON`) until woken by `SwarmHub`.
	 * - Coordinator (`actor === "coordinator"`) or non-session test calls block in-memory via `SwarmHub.waitForBoardSignal`.
	 */
	async waitForBoard(params: {
		session: ToolSession;
		since: number;
		mentionsOnly: boolean;
		timeoutMs?: number;
		signal?: AbortSignal;
	}): Promise<{
		text: string;
		interrupted?: boolean;
		head: number;
		parked?: boolean;
		waitSince?: number;
		wakeMode?: SwarmWakeMode;
	}> {
		const hub = SwarmHub.global();
		const snap = await hub.getSnapshot(this.dir);
		if (!snap.roster) {
			throw new Error("no swarm yet; add a worker to start one");
		}
		const actor = this.resolveActorName(params.session, snap.roster);
		const member = snap.roster.members[actor];
		if (!member) {
			throw new Error(`this conversation ("${actor}") is not a member of the swarm`);
		}
		if (member.killed) {
			throw new Error(`"${actor}" was killed and cannot wait on the board`);
		}

		const wakeMode: SwarmWakeMode = params.mentionsOnly ? "mentions" : "anything";
		const useParkOnYield = Boolean(params.session.parkOnSwarmWait && actor !== "coordinator");

		if (useParkOnYield) {
			const res = await hub.parkMemberTurn(this.dir, {
				memberName: actor,
				since: params.since,
				mentionsOnly: params.mentionsOnly,
				timeoutMs: params.timeoutMs,
			});
			if (!res.parked && res.immediate) {
				const first = res.immediate.matching[0]!.seq;
				const last = res.immediate.matching[res.immediate.matching.length - 1]!.seq;
				const header =
					first === last
						? `Board message #${first} arrived before waiting completed; reading the board before waiting again.`
						: `Board messages #${first}–#${last} arrived before waiting completed; reading the board before waiting again.`;
				const view = await hub.readView(this.dir, {
					memberName: actor,
					since: params.since,
					limit: 50,
				});
				const rendered = formatBoardMessagesMarkdown(view.messages);
				return {
					text: rendered ? `${header}\n\n${rendered}` : header,
					head: view.head,
					parked: false,
					waitSince: params.since,
					wakeMode,
				};
			}
			return {
				text: "Parked in swarm_wait; sleeping at zero token cost until a concerning message arrives.",
				head: res.head,
				parked: true,
				waitSince: params.since,
				wakeMode,
			};
		}

		const event = await hub.waitForBoardSignal(this.dir, {
			memberName: actor,
			since: params.since,
			mentionsOnly: params.mentionsOnly,
			timeoutMs: params.timeoutMs,
			signal: params.signal,
		});

		if (event.kind === "aborted") {
			return {
				text: "Wait interrupted by message.",
				interrupted: true,
				head: event.head,
			};
		}
		if (event.kind === "killed") {
			throw new Error(`@${actor} was killed while waiting on the board`);
		}
		if (event.kind === "model_switch") {
			return {
				text: event.text,
				head: event.head,
			};
		}
		if (event.kind === "timeout") {
			return {
				text: prompt
					.render(boardNoticeTemplate, {
						isTimeout: true,
						timeoutMs: params.timeoutMs ?? 0,
						headSeq: event.head,
						lastReadSeq: event.lastReadSeq,
					})
					.trim(),
				head: event.head,
			};
		}

		const view = await hub.readView(this.dir, {
			memberName: actor,
			since: params.since,
			limit: 50,
		});
		const body = formatBoardMessagesMarkdown(view.messages);
		if (event.immediate) {
			const first = view.messages[0]?.seq ?? event.message.seq;
			const last = view.messages[view.messages.length - 1]?.seq ?? event.message.seq;
			const header =
				first === last
					? `Board message #${first} arrived before waiting completed; reading the board before waiting again.`
					: `Board messages #${first}–#${last} arrived before waiting completed; reading the board before waiting again.`;
			return {
				text: body ? `${header}\n\n${body}` : header,
				head: view.head,
			};
		}
		const whatLabel = params.mentionsOnly ? "a message that calls on you by name, or on @all" : "any message";
		const lead = `Waiting for ${whatLabel} posted after #${params.since} — woke on #${event.message.seq} from @${event.message.agent}.`;
		return {
			text: body ? `${lead}\n\n${body}` : lead,
			head: view.head,
		};
	}

	/** Resolve a model string or display name against `session.modelRegistry`. */
	resolveSwarmModel(session: ToolSession, requestedModel?: string): { model: Model | undefined; pattern: string } {
		const trimmed = requestedModel?.trim();
		const registry = session.modelRegistry;
		if (!trimmed) {
			const active = session.getActiveModel?.();
			const pattern = formatModelLabel(active, session.getActiveModelString?.() ?? session.getModelString?.());
			return { model: active, pattern };
		}
		if (!registry) {
			return { model: undefined, pattern: trimmed };
		}
		const slashIdx = trimmed.indexOf("/");
		if (slashIdx > 0) {
			const prov = trimmed.slice(0, slashIdx);
			const id = trimmed.slice(slashIdx + 1);
			const exact = registry.find(prov, id);
			if (exact) return { model: exact, pattern: `${exact.provider}/${exact.id}` };
		}
		const available = registry.getAvailable("chat");
		const allModels = available.length > 0 ? available : registry.getAll("chat");
		const byId = allModels.filter(m => m.id.toLowerCase() === trimmed.toLowerCase());
		if (byId.length >= 1) {
			return { model: byId[0]!, pattern: `${byId[0]!.provider}/${byId[0]!.id}` };
		}
		const byName = allModels.filter(m => m.name?.toLowerCase() === trimmed.toLowerCase());
		if (byName.length === 1) {
			return { model: byName[0]!, pattern: `${byName[0]!.provider}/${byName[0]!.id}` };
		}
		if (byName.length > 1) {
			const candidates = byName.map(m => `${m.provider}/${m.id}`).join(", ");
			throw new Error(`display name "${trimmed}" matches several models (${candidates}); name one by provider/id`);
		}
		throw new Error(`unknown model "${trimmed}"; check swarm{action:"models"}`);
	}

	/** List available swarm models as markdown (`swarm{action:"models"}`). */
	listModelsMarkdown(session: ToolSession, includeAll = false): string {
		const registry = session.modelRegistry;
		const ownPattern = formatModelLabel(
			session.getActiveModel?.(),
			session.getActiveModelString?.() ?? session.getModelString?.(),
		);
		if (!registry) {
			return `- \`${ownPattern}\` (active session model)`;
		}
		const models = includeAll ? registry.getAll("chat") : registry.getAvailable("chat");
		const list = models.length > 0 ? models : registry.getAll("chat");
		const capped = includeAll ? list.slice(0, 120) : list.slice(0, 30);
		const lines = capped.map(m => {
			const id = `${m.provider}/${m.id}`;
			const activeMark = id === ownPattern ? " *(your active model — default)*" : "";
			return `- \`${id}\`${m.name && m.name !== m.id ? ` — ${m.name}` : ""}${activeMark}`;
		});
		lines.push(
			"",
			includeAll
				? `Showing ${capped.length} of ${list.length} configured models. Leave \`model\` off \`add\` to use your own active model (\`${ownPattern}\`).`
				: `Suggestions from your active providers (${capped.length} of ${list.length}). Leave \`model\` off \`add\` to run workers on your own active model (\`${ownPattern}\`), or pass \`all: true\` to list all.`,
		);
		return lines.join("\n");
	}

	/** Spawn one worker or a numbered `<name>-1..<name>-k` group and post the public brief on `board.jsonl`. */
	async spawnMembers(params: {
		session: ToolSession;
		name: string;
		brief: string;
		model?: string;
		workspace?: SwarmWorkspaceMode;
		fork?: string;
		n?: number;
		tasks?: readonly string[];
		channels?: readonly string[];
		role?: SwarmRole;
	}): Promise<{ text: string; added: string[]; seq: number; head: number }> {
		const hub = SwarmHub.global();
		const baseName = validateWorkerName(params.name);
		const trimmedBrief = params.brief.trim();
		if (!trimmedBrief) {
			throw new Error("brief is required: a worker starts fresh and does nothing without one");
		}
		const workspace: SwarmWorkspaceMode = params.workspace ?? "inherit";
		if (workspace !== "inherit" && workspace !== "share" && workspace !== "branch") {
			throw new Error(`workspace must be inherit, share or branch, got "${String(workspace)}"`);
		}

		if (params.n !== undefined && (!Number.isInteger(params.n) || params.n < 1)) {
			throw new Error(`n must be at least 1, got ${params.n}`);
		}
		if (params.tasks !== undefined) {
			if (!Array.isArray(params.tasks) || params.tasks.length === 0) {
				throw new Error("tasks must be a non-empty array when provided");
			}
			for (let i = 0; i < params.tasks.length; i++) {
				if (typeof params.tasks[i] !== "string" || !params.tasks[i]!.trim()) {
					throw new Error(`tasks[${i}] is empty: every worker needs an assignment`);
				}
			}
			if (params.n !== undefined && params.n !== params.tasks.length) {
				throw new Error(`n (${params.n}) must match len(tasks) (${params.tasks.length}), or omit n`);
			}
		}

		let roster = (await hub.getSnapshot(this.dir)).roster;
		const isTopLevel = (params.session.taskDepth ?? 0) === 0;
		const hadNoSwarmBefore = !roster;
		if (!roster && !isTopLevel) {
			throw new Error("no swarm yet; only the coordinator can start one");
		}

		const actor = this.resolveActorName(params.session, roster);
		const actorRow = roster?.members[actor];
		if (roster && (!actorRow || actorRow.killed)) {
			throw new Error(`this conversation ("${actor}") is not a live member of the swarm`);
		}

		// Validate `fork` source + optional live isolated workspace cloning
		let forkFromAgentId: string | undefined;
		let forkFromLabel: string | undefined;
		let forkMemberRecord: SwarmMemberRecord | undefined;
		let isolationSourceCwd: string | undefined;
		let forkWorkspaceWarning: string | undefined;
		if (params.fork !== undefined && params.fork.trim() !== "") {
			const forkName = params.fork.trim();
			if (forkName === "coordinator") {
				forkFromAgentId = "coordinator";
				forkFromLabel = "coordinator";
			} else {
				const forkMember = roster?.members[forkName];
				if (!forkMember) {
					throw new Error(`cannot fork "${forkName}": no swarm member with that name`);
				}
				forkMemberRecord = forkMember;
				forkFromAgentId = forkMember.agent_id;
				forkFromLabel = forkMember.name;
				const reg = params.session.agentRegistry ?? AgentRegistry.global();
				const forkRef = reg.get(forkMember.agent_id);
				const forkCwd = forkRef?.session?.sessionManager.getCwd();
				if (workspace !== "inherit" && forkMember.workspace !== "inherit") {
					if (forkCwd && (await directoryExists(forkCwd))) {
						isolationSourceCwd = forkCwd;
					} else {
						forkWorkspaceWarning = `Note: could not locate @${forkMember.name}'s isolated workspace on disk; cloned from current workspace instead.`;
					}
				} else if (workspace === "inherit" && forkMember.workspace !== "inherit") {
					forkWorkspaceWarning = `Note: @${forkMember.name} used workspace "${forkMember.workspace}" while this fork uses "inherit"; pass workspace:"share" or "branch" to clone its worktree edits.`;
				}
			}
		}

		const channelMap = new Map<string, SwarmChannelInfo>((roster?.channels ?? []).map(c => [c.name, c]));
		const isActiveChannel = (ch: string) => {
			const info = channelMap.get(ch);
			return Boolean(info && !info.archived);
		};
		let memberChannels: string[] | null = null;
		if (params.channels && params.channels.length > 0) {
			const normalized: string[] = [];
			for (const rawCh of params.channels) {
				const ch = validateChannelName(rawCh);
				if (!isActiveChannel(ch)) {
					throw new Error(`channel #${ch} does not exist or is archived`);
				}
				if (!normalized.includes(ch)) normalized.push(ch);
			}
			memberChannels = normalized.length > 0 ? normalized : null;
		} else if (actor !== "coordinator" && actorRow?.channels && actorRow.channels.length > 0) {
			const inherited = actorRow.channels.filter(isActiveChannel);
			memberChannels = inherited.length > 0 ? inherited : null;
		}

		const { pattern: modelPattern } = this.resolveSwarmModel(params.session, params.model);

		const groupSize = params.tasks ? params.tasks.length : (params.n ?? 1);
		const isGroup = groupSize > 1 || Boolean(params.tasks);
		const planned = Array.from({ length: groupSize }, (_, idx) => {
			const workerName = isGroup ? `${baseName}-${idx + 1}` : baseName;
			const role = effectiveRole(workerName, params.role);
			const sliceTask = params.tasks?.[idx]?.trim();
			return {
				name: workerName,
				role,
				copyIndex: idx + 1,
				zeroIndex: idx,
				sliceTask,
			};
		});

		if (planned.some(p => isRoleObserver(p.name, p.role)) && workspace !== "inherit") {
			throw new Error('narrator and monitor observers must use workspace "inherit"');
		}
		if (roster) {
			for (const candidate of planned) {
				if (Object.hasOwn(roster.members, candidate.name)) {
					throw new Error(`the swarm already has a member named "${candidate.name}"`);
				}
			}
		}

		// Build worker session wrapper & isolation settings upfront so preflight catches EVERY error before touching board.jsonl/members.json.
		const effectiveSession: ToolSession =
			workspace === "share" || workspace === "branch"
				? {
						...params.session,
						settings: createSubagentSettings(params.session.settings, {
							"task.isolation.enabled": true,
						}),
						suppressSpawnAdvisory: true,
					}
				: {
						...params.session,
						suppressSpawnAdvisory: true,
					};
		const isolation =
			workspace === "share"
				? ({ requested: true, merge: "patch", apply: false } as const)
				: workspace === "branch"
					? ({ requested: true, merge: "branch", apply: false } as const)
					: undefined;

		for (const p of planned) {
			const bundledAgent =
				p.role === "narrator" ? "swarm-narrator" : p.role === "monitor" ? "swarm-monitor" : "swarm-worker";
			await resolveEffectiveSubagentPolicy({
				session: effectiveSession,
				invocationKind: "task",
				agent: bundledAgent,
				assignment: trimmedBrief,
				model: modelPattern !== "default" ? [modelPattern] : undefined,
				structured: false,
				isolation,
				forkFrom: forkFromAgentId,
			});
		}
		if (forkMemberRecord && isolationSourceCwd && !forkWorkspaceWarning) {
			logger.debug("Swarm fork cloning live isolated workspace", {
				from: forkMemberRecord.name,
				cwd: isolationSourceCwd,
			});
		}

		if (!roster) {
			roster = await this.ensureCoordinatorSwarm(params.session);
		}
		await promoteSwarmToolsOnSession(params.session);
		const liveActorRow = roster.members[actor]!;
		const homeChannel = homeChannelIn(memberChannels, isActiveChannel);
		const targetLabel = isGroup ? baseName : planned[0]!.name;
		let publicBriefText = `@${targetLabel} ${trimmedBrief}`;
		if (params.tasks && params.tasks.length > 0) {
			const sliceLines = planned.map(p => `- @${p.name}: ${p.sliceTask}`).join("\n");
			publicBriefText += `\n\nAssigned slices:\n${sliceLines}`;
		}

		const parentPrefix =
			actor === "coordinator" ? undefined : (params.session.getAgentId?.() ?? liveActorRow.agent_id);

		const newRows: Array<Omit<SwarmMemberRecord, "last_read_seq" | "wait_since" | "updated_at">> = planned.map(p => {
			const expectedAgentId = parentPrefix ? `${parentPrefix}.${p.name}` : p.name;
			return {
				name: p.name,
				agent_id: expectedAgentId,
				conversation_id: expectedAgentId,
				role: p.role,
				added_by: actor,
				model: modelPattern,
				workspace,
				channels: isRoleObserver(p.name, p.role) ? null : memberChannels,
				wake_mode: p.role === "narrator" ? "anything" : "mentions",
				killed: false,
			};
		});

		const senderAgentId = params.session.getAgentId?.() ?? liveActorRow.agent_id;
		const { briefMessage } = await hub.addMembersWithBrief(this.dir, {
			actor,
			senderAgentId,
			briefText: publicBriefText,
			briefChannel: homeChannel,
			newMembers: newRows,
		});

		for (const p of planned) {
			const bundledAgent =
				p.role === "narrator" ? "swarm-narrator" : p.role === "monitor" ? "swarm-monitor" : "swarm-worker";
			const assignment = prompt
				.render(workerBriefingTemplate, {
					name: p.name,
					forkedFrom: forkFromLabel,
					groupSize: isGroup ? groupSize : undefined,
					copyIndex: p.copyIndex,
					zeroIndex: p.zeroIndex,
					groupPrefix: baseName,
					briefSeq: briefMessage.seq,
					targetLabel,
					sliceTask: p.sliceTask,
					brief: trimmedBrief,
					channelsList:
						memberChannels && memberChannels.length > 0 && !isRoleObserver(p.name, p.role)
							? memberChannels.map(c => `#${c}`).join(", ")
							: undefined,
					homeChannel,
					swarmDir: p.role === "narrator" ? this.dir : undefined,
				})
				.trim();

			this.#launchBackgroundWorker({
				effectiveSession,
				memberName: p.name,
				expectedAgentId: parentPrefix ? `${parentPrefix}.${p.name}` : p.name,
				bundledAgent,
				assignment,
				modelPattern,
				isolation,
				isolationSourceCwd,
				forkFrom: forkFromAgentId,
			});
		}

		const spawnedLabel =
			planned.length === 1
				? `Spawned worker @${planned[0]!.name} (${modelPattern}).`
				: `Spawned ${planned.length} workers (@${planned[0]!.name}–@${planned[planned.length - 1]!.name}, ${modelPattern}).`;
		const boardLoc =
			homeChannel !== SWARM_MAIN_CHANNEL
				? `The brief is on the board as #${briefMessage.seq} in #${homeChannel}, the new workers' home channel, which is where their posts go by default.`
				: `The brief is on the board as #${briefMessage.seq}, where every member of the swarm can read it.`;
		const wsNote =
			workspace !== "inherit"
				? ` Each worker works in its own "${workspace}" workspace, which kill deletes: land its work first before killing.`
				: "";
		const helperNote =
			actor !== "coordinator"
				? ` You added it, so its results are yours to integrate: ensure it reports back to @${actor} by name, and kill it once its work is done and integrated.`
				: hadNoSwarmBefore
					? ` SWARM_DIR=${this.dir} (run \`/swarm board\` at any time to view the live board).`
					: ` SWARM_DIR=${this.dir}.`;
		const warningNote = forkWorkspaceWarning ? ` ${forkWorkspaceWarning}` : "";

		return {
			text: `${spawnedLabel} ${boardLoc}${wsNote}${helperNote}${warningNote}`,
			added: planned.map(p => p.name),
			seq: briefMessage.seq,
			head: briefMessage.seq,
		};
	}

	#launchBackgroundWorker(options: {
		effectiveSession: ToolSession;
		memberName: string;
		expectedAgentId: string;
		bundledAgent: string;
		assignment: string;
		modelPattern: string;
		isolation?: { requested: true; merge: "patch" | "branch"; apply: false };
		isolationSourceCwd?: string;
		forkFrom?: string;
	}): void {
		const abortController = new AbortController();
		const runRecord: ActiveWorkerRun = {
			memberName: options.memberName,
			agentId: options.expectedAgentId,
			abortController,
			running: true,
		};
		this.#activeRuns.set(options.memberName, runRecord);

		const hub = SwarmHub.global();
		void (async () => {
			try {
				const outcome = await runStructuredSubagent({
					session: options.effectiveSession,
					invocationKind: "task",
					agent: options.bundledAgent,
					assignment: options.assignment,
					model: options.modelPattern !== "default" ? [options.modelPattern] : undefined,
					structured: false,
					detached: true,
					keepAlive: true,
					maxRuntimeMs: 0,
					identity: {
						id: options.memberName,
						label: options.memberName,
					},
					isolation: options.isolation,
					isolationSourceCwd: options.isolationSourceCwd,
					forkFrom: options.forkFrom,
					swarmContext: { swarmDir: this.dir, memberName: options.memberName },
					signal: abortController.signal,
				});
				const actualId = outcome.result.id;
				if (actualId && actualId !== options.expectedAgentId) {
					hub.registerAgentBinding(this.dir, actualId, options.memberName);
					runRecord.agentId = actualId;
					await hub.updateMemberFields(this.dir, options.memberName, { agent_id: actualId });
				}
				const wsNote = outcome.result.branchName
					? `branch:${outcome.result.branchName}`
					: outcome.result.patchPath
						? `patch:${outcome.result.patchPath}`
						: undefined;
				if (outcome.result.exitCode !== 0 && !outcome.result.aborted) {
					const errText = outcome.result.error || outcome.result.stderr || "worker turn failed";
					await hub.reportMemberTurnError(this.dir, options.memberName, errText, isSwarmQuotaError(errText));
					if (wsNote) {
						await hub.updateMemberFields(this.dir, options.memberName, { workspace_note: wsNote });
					}
				} else {
					await hub.clearMemberError(this.dir, options.memberName);
					if (wsNote) {
						await hub.updateMemberFields(this.dir, options.memberName, { workspace_note: wsNote });
					}
				}
			} catch (err) {
				if (!abortController.signal.aborted) {
					const msg = err instanceof Error ? err.message : String(err);
					await hub.reportMemberTurnError(this.dir, options.memberName, msg, isSwarmQuotaError(msg));
				}
			} finally {
				runRecord.running = false;
			}
		})();
	}

	/** Kill a worker (or numbered `<name>-1..<name>-k` group) respecting `added_by` ownership. */
	async killMembers(params: { session: ToolSession; name: string }): Promise<{ text: string; killed: string[] }> {
		const target = params.name.trim();
		if (!target) throw new Error("name is required");
		if (target === "coordinator") {
			throw new Error("@coordinator is the coordinator and cannot be killed");
		}
		const hub = SwarmHub.global();
		const snap = await hub.getSnapshot(this.dir);
		if (!snap.roster) throw new Error("no swarm yet; add a worker to start one");
		const actor = this.resolveActorName(params.session, snap.roster);

		const exact = snap.roster.members[target];
		const groupMatches = exact
			? [exact]
			: Object.values(snap.roster.members).filter(m => {
					const match = /^(.+)-(\d+)$/.exec(m.name);
					return match?.[1] === target && !m.killed;
				});

		if (groupMatches.length === 0) {
			throw new Error(`no live swarm member named "${target}"`);
		}

		for (const m of groupMatches) {
			if (m.name === "coordinator") {
				throw new Error("@coordinator is the coordinator and cannot be killed");
			}
			if (actor !== "coordinator" && m.added_by !== actor) {
				throw new Error(`you may kill only the workers you added, not @${m.name}; ask @coordinator on the board`);
			}
		}

		const toKill = groupMatches.filter(m => !m.killed).map(m => m.name);
		if (toKill.length === 0) {
			return { text: `@${target} is already killed.`, killed: [] };
		}

		await hub.markKilled(this.dir, toKill);
		const lifecycle = params.session.agentLifecycle?.() ?? AgentLifecycleManager.global();
		const reg = params.session.agentRegistry ?? AgentRegistry.global();

		for (const m of groupMatches) {
			hub.notifyKilled(this.dir, m.name);
			const run = this.#activeRuns.get(m.name);
			if (run) {
				run.abortController.abort("killed by swarm");
				run.running = false;
			}
			const ref = reg.get(m.agent_id);
			if (ref) {
				await lifecycle.release(m.agent_id, ref, { tombstone: true }).catch(() => {});
			}
		}

		const label =
			toKill.length === 1
				? `Killed worker @${toKill[0]!}.`
				: `Killed ${toKill.length} workers (@${toKill[0]!}–@${toKill[toKill.length - 1]!}).`;
		return { text: label, killed: toKill };
	}

	/** Switch a member's (or caller's own) model while preserving conversation history (`swarm{action:"model"}`). */
	async switchMemberModel(params: {
		session: ToolSession;
		name?: string;
		model?: string;
	}): Promise<{ text: string; target: string; model: string; selfSwitch: boolean }> {
		const hub = SwarmHub.global();
		const snap = await hub.getSnapshot(this.dir);
		if (!snap.roster) throw new Error("no swarm yet; add a worker to start one");
		const actor = this.resolveActorName(params.session, snap.roster);
		const targetName = params.name?.trim() || actor;
		const targetRow = snap.roster.members[targetName];
		if (!targetRow) {
			throw new Error(`no swarm member named "${targetName}"`);
		}
		if (targetRow.killed) {
			throw new Error(`"${targetName}" was killed and cannot be revived; add a new worker instead`);
		}
		const isSelf = targetName === actor;
		if (isSelf && (!params.model || !params.model.trim())) {
			throw new Error("model is required when switching your own model");
		}
		if (!isSelf && actor !== "coordinator" && targetRow.added_by !== actor) {
			throw new Error(
				`you may switch the model of only the workers you added, not @${targetName}; ask @coordinator on the board`,
			);
		}

		if (!isSelf) {
			const currentStatus = this.memberStatusOf(targetRow);
			if (currentStatus === "working") {
				throw new Error(`worker "${targetName}" is mid-turn; switch its model once status shows it waiting`);
			}
		}

		const { model: resolvedModel, pattern } = this.resolveSwarmModel(params.session, params.model);
		const reg = params.session.agentRegistry ?? AgentRegistry.global();
		const lifecycle = params.session.agentLifecycle?.() ?? AgentLifecycleManager.global();

		if (isSelf && params.session.scheduleSwarmSelfModelSwitch && resolvedModel) {
			params.session.scheduleSwarmSelfModelSwitch({
				swarmDir: this.dir,
				memberName: actor,
				agentId: targetRow.agent_id,
				model: resolvedModel,
				modelLabel: pattern,
			});
			return {
				text: `Switching your model to \`${pattern}\` and continuing once this turn settles.`,
				target: targetName,
				model: pattern,
				selfSwitch: true,
			};
		}

		let targetRef = reg.get(targetRow.agent_id);
		if (targetRef && !targetRef.session && targetRef.status === "parked") {
			await lifecycle.ensureLive(targetRow.agent_id);
			targetRef = reg.get(targetRow.agent_id);
		}
		if (targetRef?.session && resolvedModel && typeof targetRef.session.setModel === "function") {
			await targetRef.session.setModel(resolvedModel);
		}

		await hub.notifyModelSwitched(this.dir, {
			memberName: targetName,
			targetAgentId: targetRow.agent_id,
			actor,
			selfSwitch: isSelf,
			modelLabel: pattern,
		});

		return {
			text: isSelf ? `Switched your model to \`${pattern}\`.` : `Switched worker @${targetName} to \`${pattern}\`.`,
			target: targetName,
			model: pattern,
			selfSwitch: isSelf,
		};
	}

	/** Render `swarm{action:"status"}` markdown. */
	async formatStatusMarkdown(registry?: AgentRegistryApi): Promise<string> {
		const snap = await SwarmHub.global().getSnapshot(this.dir);
		if (!snap.roster) {
			return '{"status":"no swarm yet; add a worker to start one"}';
		}
		const reg = registry ?? AgentRegistry.global();
		const channelMap = new Map<string, SwarmChannelInfo>(snap.roster.channels.map(c => [c.name, c]));
		const isActiveChannel = (ch: string) => {
			const info = channelMap.get(ch);
			return Boolean(info && !info.archived);
		};

		const members = Object.values(snap.roster.members);
		const lines: string[] = [];
		const titlePart = snap.roster.title ? ` — ${snap.roster.title}` : "";
		lines.push(`### Swarm Status${titlePart} (board head: #${snap.head}, dir: \`${this.dir}\`)`);
		lines.push("");

		let taskAgents = 0;
		let waitingCount = 0;
		let workingCount = 0;
		let stoppedCount = 0;

		for (const m of members) {
			const status = this.memberStatusOf(m);
			const observer = isRoleObserver(m.name, m.role);
			if (m.name !== "coordinator" && !observer && !m.killed) {
				taskAgents += 1;
				if (status === "waiting") waitingCount += 1;
				else if (status === "working") workingCount += 1;
				else if (status === "stopped") stoppedCount += 1;
			}
			const effSet = effectiveChannels(m.role, m.channels, m.name);
			const unread = snap.messages.filter(
				msg =>
					msg.seq > m.last_read_seq &&
					msg.agent !== m.name &&
					seesIn(m.name, effSet, msg, isActiveChannel) &&
					countsAsUnread(msg),
			).length;

			const roleBadge = m.role !== "worker" ? `, role: ${m.role}` : "";
			const wsBadge =
				m.workspace !== "inherit"
					? `, workspace: ${m.workspace}${m.workspace_note ? ` (${m.workspace_note})` : ""}`
					: "";
			const chBadge =
				m.channels && m.channels.length > 0 ? `, channels: ${m.channels.map(c => `#${c}`).join(", ")}` : "";
			const unreadBadge = unread > 0 ? `, **${unread} unread**` : "";
			const lastSeen = m.last_post_seq ? `, last post #${m.last_post_seq} (${relativeAge(m.last_post_time)})` : "";
			const errBadge = m.quota_exhausted
				? ` — **[quota exhausted: ${m.last_error ?? "switch model"}]**`
				: m.last_error
					? ` — **[error: ${m.last_error}]**`
					: "";
			const activity = reg.get(m.agent_id)?.activity;
			const actBadge = status === "working" && activity ? ` — *${activity}*` : "";
			lines.push(
				`- **@${m.name}** (${status}${roleBadge}, model: \`${m.model}\`${wsBadge}${chBadge}${unreadBadge}${lastSeen})${actBadge}${errBadge}`,
			);
		}

		const stoppedSuffix = stoppedCount > 0 ? `, ${stoppedCount} stopped (a post naming one revives it)` : "";
		lines.push("");
		lines.push(`${taskAgents} task worker(s): ${workingCount} working, ${waitingCount} waiting${stoppedSuffix}.`);
		return lines.join("\n");
	}

	/** Render `read_board{status: true}` monitor table (`| member | state | parked on | last post |`). */
	async formatMonitorStatusTable(): Promise<string> {
		const snap = await SwarmHub.global().getSnapshot(this.dir);
		if (!snap.roster) {
			return "No swarm yet.";
		}
		const lines = [
			`Swarm status (board #${snap.head}):`,
			"",
			"| member | state | parked on | last post |",
			"|---|---|---|---|",
		];
		for (const m of Object.values(snap.roster.members)) {
			const state = this.memberStatusOf(m);
			const parkedOn =
				state === "waiting" || state === "stopped"
					? `${m.wake_mode === "anything" ? "any message" : "@mentions"} after #${m.wait_since} (read #${m.last_read_seq})`
					: `read #${m.last_read_seq}`;
			const lastPost = m.last_post_seq ? `#${m.last_post_seq} (${relativeAge(m.last_post_time)})` : "—";
			lines.push(`| @${m.name} | ${state} | ${parkedOn} | ${lastPost} |`);
		}
		return lines.join("\n");
	}

	/** Render the complete `/swarm board [--channel <name>]` live view (Overview + Members + Recent Feed). */
	async formatLiveBoardView(options?: {
		channel?: string;
		limit?: number;
		overviewOnly?: boolean;
		registry?: AgentRegistryApi;
	}): Promise<string> {
		const hub = SwarmHub.global();
		const snap = await hub.getSnapshot(this.dir);
		if (!snap.roster) {
			return "No swarm in this conversation. Start one with `/swarm <task>`.";
		}
		const reg = options?.registry ?? AgentRegistry.global();
		const rosterNames = Object.keys(snap.roster.members);
		const overview: SwarmOverviewView | null = await hub.readNarratorOverview(this.dir, snap.head, rosterNames);

		const title = snap.roster.title || snap.roster.swarm_id;
		const memberList = Object.values(snap.roster.members);
		const liveCount = memberList.filter(m => !m.killed).length;
		const header = `## Swarm: ${title} · ${liveCount} live members · ${snap.head} posts`;
		const sections: string[] = [header];

		if (overview) {
			const ovLines: string[] = ["### Narrator Overview"];
			if (overview.goal) {
				ovLines.push(`**Goal:** ${overview.goal.title} — ${overview.goal.line}`);
			} else if (overview.headline) {
				ovLines.push(`**Headline:** ${overview.headline}`);
			}
			if (overview.phase) {
				ovLines.push(`**Phase:** ${overview.phase.label} (${overview.phase.index}/${overview.phase.total})`);
			}
			if (overview.running_summary) {
				ovLines.push(`**Now:** ${overview.running_summary}`);
			}
			if (overview.attention.length > 0) {
				ovLines.push("", "**Attention:**");
				for (const att of overview.attention) {
					const cite = att.refs.map(r => (r.seq ? `#${r.seq}` : `@${r.member}`)).join(", ");
					ovLines.push(
						`- **[${att.kind.toUpperCase()} · ${att.severity}]** ${att.title}${att.why ? ` — ${att.why}` : ""}${cite ? ` (${cite})` : ""}`,
					);
				}
			}
			if (overview.workstreams.length > 0) {
				ovLines.push("", "**Workstreams:**");
				for (const ws of overview.workstreams) {
					const owners = ws.owners.map(o => `@${o}`).join(", ");
					const prog = ws.progress ? ` [${ws.progress.done}/${ws.progress.total}]` : "";
					ovLines.push(
						`- \`[${ws.state}]\` **${ws.title}**${prog} (${owners || "unassigned"})${ws.note ? ` — ${ws.note}` : ""}`,
					);
				}
			}
			sections.push(ovLines.join("\n"));
			if (options?.overviewOnly) {
				return sections.join("\n\n");
			}
		} else if (options?.overviewOnly) {
			sections.push("*No `view.json` narrator overview published yet.*");
			return sections.join("\n\n");
		}

		sections.push(await this.formatStatusMarkdown(reg));

		const view = await hub.readView(this.dir, {
			memberName: "coordinator",
			channel: options?.channel || SWARM_ALL_CHANNELS,
			limit: options?.limit ?? 25,
			advanceCursor: false,
		});
		if (view.messages.length === 0) {
			sections.push(`### Board Feed (${view.channelLabel})\n*No posts yet.*`);
		} else {
			sections.push(
				`### Last ${view.messages.length} of ${snap.head} posts (${view.channelLabel})\n${formatBoardMessagesMarkdown(view.messages)}`,
			);
		}
		return sections.join("\n\n");
	}
}

export function formatBoardMessagesMarkdown(messages: readonly SwarmBoardMessage[]): string {
	if (messages.length === 0) return "";
	return messages
		.map(msg => {
			const ch = messageChannelOf(msg);
			const chTag = ch !== SWARM_MAIN_CHANNEL ? ` #${ch}` : "";
			return `**#${msg.seq} @${msg.agent}**${chTag} (${msg.time}):\n${msg.text}`;
		})
		.join("\n\n");
}
