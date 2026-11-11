import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import boardNoticeTemplate from "../prompts/swarm/board-notice.md" with { type: "text" };
import workerBriefingTemplate from "../prompts/swarm/worker-briefing.md" with { type: "text" };
import { IrcBus } from "../irc/bus";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry, type AgentRegistryApi, MAIN_AGENT_ID } from "../registry/agent-registry";
import { isLocalAgentSession } from "../session/agent-session-handle";
import { createSubagentSettings } from "../task/executor";
import { runStructuredSubagent } from "../task/structured-subagent";
import type { ToolSession } from "../tools";
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

const QUOTA_ERROR_RE = /RESOURCE_EXHAUSTED|quota|\b429\b|exhausted your capacity|rate.?limit/i;

export const SWARM_TOOL_NAMES = ["swarm", "post_message", "read_board", "swarm_wait"] as const;

type SwarmWakeEvent =
	| {
			kind: "message";
			message: SwarmBoardMessage;
			head: number;
			lastReadSeq: number;
	  }
	| {
			kind: "model_switch";
			actorLabel: string;
			selfSwitched: boolean;
			isCoordinator: boolean;
			model: string;
	  }
	| {
			kind: "killed";
	  };

interface SwarmWaiter {
	memberName: string;
	since: number;
	mentionsOnly: boolean;
	resolve: (event: SwarmWakeEvent) => void;
}

interface ActiveWorkerRun {
	memberName: string;
	agentId: string;
	abortController: AbortController;
	running: boolean;
}

/** Resolve the shared swarm directory (`SWARM_DIR`) for any session in the tree (coordinator or nested worker). */
export function resolveSwarmDir(
	session: Pick<ToolSession, "cwd" | "getArtifactsDir" | "getSessionFile" | "getSessionId" | "localProtocolOptions">,
): string {
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
export function promoteSwarmToolsOnSession(session: ToolSession): void {
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

/**
 * Process-scoped Swarm Runtime & Wake Engine per `swarmDir`, coordinating
 * `SwarmBoardStore`, in-memory zero-token `swarm_wait` waiters, `IrcBus` wakeups,
 * worker spawning, `fork`, `workspace` isolation, and live model switching.
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
			inst = new SwarmRuntime(SwarmBoardStore.forDir(resolved));
			SwarmRuntime.#instances.set(resolved, inst);
		}
		return inst;
	}

	static resetForTests(): void {
		for (const inst of SwarmRuntime.#instances.values()) {
			inst.#disposeForTests();
		}
		SwarmRuntime.#instances.clear();
		SwarmBoardStore.resetForTests();
	}

	readonly store: SwarmBoardStore;
	readonly #waiters = new Map<string, Set<SwarmWaiter>>();
	readonly #parkedListeners = new Map<string, Set<() => void>>();
	readonly #activeRuns = new Map<string, ActiveWorkerRun>();
	readonly #agentIdToMember = new Map<string, string>();

	constructor(store: SwarmBoardStore) {
		this.store = store;
	}

	#disposeForTests(): void {
		for (const run of this.#activeRuns.values()) {
			run.abortController.abort("test reset");
		}
		this.#activeRuns.clear();
		this.#parkedListeners.clear();
		this.#waiters.clear();
		this.#agentIdToMember.clear();
	}

	/** True while `memberName` is actively parked in `swarm_wait`. */
	isParked(memberName: string): boolean {
		return (this.#waiters.get(memberName)?.size ?? 0) > 0;
	}

	/** Resolves once `memberName` enters `swarm_wait` (or immediately if already parked). */
	waitUntilParked(memberName: string): Promise<void> {
		if (this.isParked(memberName)) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		let listeners = this.#parkedListeners.get(memberName);
		if (!listeners) {
			listeners = new Set();
			this.#parkedListeners.set(memberName, listeners);
		}
		listeners.add(resolve);
		return promise;
	}

	/** Bind a registry `agentId` to its canonical swarm `memberName`. */
	registerAgentBinding(agentId: string, memberName: string): void {
		this.#agentIdToMember.set(agentId, memberName);
	}

	/** Resolve which swarm member `session` represents (`"coordinator"` at depth 0, else worker roster name). */
	resolveActorName(session: ToolSession, roster: SwarmRosterFile | null): string {
		const agentId = session.getAgentId?.() ?? MAIN_AGENT_ID;
		if ((session.taskDepth ?? 0) === 0 || agentId === MAIN_AGENT_ID) {
			return "coordinator";
		}
		const mapped = this.#agentIdToMember.get(agentId);
		if (mapped && (!roster || roster.members[mapped])) {
			return mapped;
		}
		if (roster) {
			if (roster.members[agentId]) return agentId;
			for (const member of Object.values(roster.members)) {
				if (member.agent_id === agentId || agentId.endsWith(`.${member.name}`)) {
					this.#agentIdToMember.set(agentId, member.name);
					return member.name;
				}
			}
		}
		return agentId;
	}

	/** Compute a member's live status (`killed` | `waiting` | `working` | `stopped`) matching `board.StateOf`. */
	memberStatusOf(member: SwarmMemberRecord, registry?: AgentRegistryApi): SwarmMemberStatus {
		if (member.killed) return "killed";
		const waiters = this.#waiters.get(member.name);
		if (waiters && waiters.size > 0) return "waiting";
		const run = this.#activeRuns.get(member.name);
		if (run?.running) return "working";
		const reg = registry ?? AgentRegistry.global();
		const ref = reg.get(member.agent_id);
		if (member.name === "coordinator") {
			if (ref?.session?.isStreaming) return "working";
			return "waiting";
		}
		if (!ref) {
			return "stopped";
		}
		if (ref.status === "running" || ref.session?.isStreaming) {
			return "working";
		}
		if (ref.status === "parked") {
			return "stopped";
		}
		return "waiting";
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
		const roster = await this.store.ensureSwarm({
			coordinatorAgentId,
			coordinatorConversationId: coordinatorConvId,
			model: activeModel,
			title,
		});
		this.#agentIdToMember.set(coordinatorAgentId, "coordinator");
		return roster;
	}

	/** Post a message and trigger the Wake Engine (`ring`). */
	async postAndRing(params: {
		session: ToolSession;
		text: string;
		channel?: string;
	}): Promise<{ actor: string; message: SwarmBoardMessage; warnings: string[] }> {
		const snap = await this.store.getSnapshot();
		if (!snap.roster) {
			throw new Error("no swarm yet; add a worker to start one");
		}
		const actor = this.resolveActorName(params.session, snap.roster);
		const { message, warnings, roster } = await this.store.postMessage({
			author: actor,
			text: params.text,
			channel: params.channel,
			kind: "post",
		});
		const senderAgentId = params.session.getAgentId?.() ?? roster.members[actor]?.agent_id ?? MAIN_AGENT_ID;
		await this.ring(message, roster, senderAgentId, params.session.agentRegistry);
		return { actor, message, warnings };
	}

	/** Wake sleeping `swarm_wait` callers and idle/parked `AgentSession` peers who are concerned by `message`. */
	async ring(
		message: SwarmBoardMessage,
		roster: SwarmRosterFile,
		senderAgentId: string,
		registry?: AgentRegistryApi,
	): Promise<void> {
		const reg = registry ?? AgentRegistry.global();
		const channelMap = new Map<string, SwarmChannelInfo>(roster.channels.map(c => [c.name, c]));
		const isActiveChannel = (ch: string) => {
			const info = channelMap.get(ch);
			return Boolean(info && !info.archived);
		};

		const wakePromises: Promise<unknown>[] = [];
		for (const member of Object.values(roster.members)) {
			if (member.killed || member.name === message.agent) continue;
			const memberSet = effectiveChannels(member.role, member.channels, member.name);
			const concerned =
				member.wake_mode === "anything"
					? seesIn(member.name, memberSet, message, isActiveChannel) && countsAsUnread(message)
					: mentionsIn(message.text, member.name, memberSet, isActiveChannel);
			if (!concerned) continue;

			// 1. Resolve in-memory `swarm_wait` waiters first (zero overhead, immediate tool return).
			const waiters = this.#waiters.get(member.name);
			if (waiters && waiters.size > 0) {
				const matched = [...waiters].filter(w => message.seq > w.since);
				if (matched.length > 0) {
					for (const w of matched) {
						waiters.delete(w);
						w.resolve({
							kind: "message",
							message,
							head: message.seq,
							lastReadSeq: member.last_read_seq,
						});
					}
					continue;
				}
			}

			// 2. If the member is NOT currently working a turn, wake/revive its AgentSession via IrcBus!
			const status = this.memberStatusOf(member, reg);
			if (status === "waiting" || status === "stopped") {
				const targetRef = reg.get(member.agent_id);
				if (!targetRef) continue;
				const preview = message.text.length > 240 ? `${message.text.slice(0, 239).trimEnd()}…` : message.text;
				const ch = messageChannelOf(message);
				const body = prompt
					.render(boardNoticeTemplate, {
						isModelSwitch: false,
						seq: message.seq,
						sender: message.agent,
						channelTag: ch !== SWARM_MAIN_CHANNEL ? `#${ch}` : undefined,
						preview,
						headSeq: message.seq,
						lastReadSeq: member.last_read_seq,
					})
					.trim();
				wakePromises.push(
					IrcBus.global()
						.send({
							from: senderAgentId,
							to: member.agent_id,
							body,
						})
						.catch(err => {
							logger.debug("SwarmRuntime: failed to nudge member via IrcBus", {
								member: member.name,
								agentId: member.agent_id,
								error: String(err),
							});
						}),
				);
			}
		}
		if (wakePromises.length > 0) {
			await Promise.allSettled(wakePromises);
		}
	}

	/** Check if any concerning messages already arrived after `since` for `memberName` (`WaitCheck` / `HasConcerning`). */
	async findConcerningAfter(params: {
		memberName: string;
		since: number;
		mentionsOnly: boolean;
	}): Promise<{ head: number; matching: SwarmBoardMessage[]; lastReadSeq: number }> {
		const snap = await this.store.getSnapshot();
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

	/** Park in `swarm_wait` until a concerning board post arrives, a model switch resumes the member, or `signal` aborts. */
	async waitForBoard(params: {
		session: ToolSession;
		since: number;
		mentionsOnly: boolean;
		signal?: AbortSignal;
	}): Promise<{ text: string; interrupted?: boolean; head: number }> {
		const snap = await this.store.getSnapshot();
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
		// WaitCheck / ParkGuard: never sleep if concerning messages already landed after `since`!
		const immediate = await this.findConcerningAfter({
			memberName: actor,
			since: params.since,
			mentionsOnly: params.mentionsOnly,
		});
		if (immediate.matching.length > 0) {
			const first = immediate.matching[0]!.seq;
			const last = immediate.matching[immediate.matching.length - 1]!.seq;
			const header =
				first === last
					? `Board message #${first} arrived before waiting completed; reading the board before waiting again.`
					: `Board messages #${first}–#${last} arrived before waiting completed; reading the board before waiting again.`;
			const view = await this.store.readView({
				memberName: actor,
				since: params.since,
				limit: 50,
			});
			const rendered = formatBoardMessagesMarkdown(view.messages);
			return {
				text: rendered ? `${header}\n\n${rendered}` : header,
				head: view.head,
			};
		}

		await this.store.recordWait(actor, params.since, wakeMode);

		// Re-check once after recording wait_since to close any micro-race with concurrent postMessage.
		const recheck = await this.findConcerningAfter({
			memberName: actor,
			since: params.since,
			mentionsOnly: params.mentionsOnly,
		});
		if (recheck.matching.length > 0) {
			const first = recheck.matching[0]!.seq;
			const last = recheck.matching[recheck.matching.length - 1]!.seq;
			const header =
				first === last
					? `Board message #${first} arrived before waiting completed; reading the board before waiting again.`
					: `Board messages #${first}–#${last} arrived before waiting completed; reading the board before waiting again.`;
			const view = await this.store.readView({
				memberName: actor,
				since: params.since,
				limit: 50,
			});
			const rendered = formatBoardMessagesMarkdown(view.messages);
			return {
				text: rendered ? `${header}\n\n${rendered}` : header,
				head: view.head,
			};
		}

		if (params.signal?.aborted) {
			return {
				text: "Wait interrupted by message.",
				interrupted: true,
				head: recheck.head,
			};
		}

		const { promise, resolve } = Promise.withResolvers<SwarmWakeEvent | { kind: "aborted" }>();
		const waiter: SwarmWaiter = {
			memberName: actor,
			since: params.since,
			mentionsOnly: params.mentionsOnly,
			resolve: event => resolve(event),
		};
		let set = this.#waiters.get(actor);
		if (!set) {
			set = new Set();
			this.#waiters.set(actor, set);
		}
		set.add(waiter);
		const parkedListeners = this.#parkedListeners.get(actor);
		if (parkedListeners) {
			for (const notify of parkedListeners) notify();
			parkedListeners.clear();
		}

		const onAbort = () => {
			set?.delete(waiter);
			resolve({ kind: "aborted" });
		};
		params.signal?.addEventListener("abort", onAbort, { once: true });

		let event: SwarmWakeEvent | { kind: "aborted" };
		try {
			event = await promise;
		} finally {
			params.signal?.removeEventListener("abort", onAbort);
			set.delete(waiter);
		}

		if (event.kind === "aborted") {
			return {
				text: "Wait interrupted by message.",
				interrupted: true,
				head: (await this.store.getSnapshot()).head,
			};
		}
		if (event.kind === "killed") {
			throw new Error(`@${actor} was killed while waiting on the board`);
		}
		if (event.kind === "model_switch") {
			const snapAfter = await this.store.getSnapshot();
			return {
				text: prompt
					.render(boardNoticeTemplate, {
						isModelSwitch: true,
						actorLabel: event.actorLabel,
						selfSwitched: event.selfSwitched,
						isCoordinator: event.isCoordinator,
						model: event.model,
					})
					.trim(),
				head: snapAfter.head,
			};
		}

		// Woke on concerning message: read unread messages since `params.since` and return them directly!
		const view = await this.store.readView({
			memberName: actor,
			since: params.since,
			limit: 50,
		});
		const whatLabel = params.mentionsOnly ? "a message that calls on you by name, or on @all" : "any message";
		const lead = `Waiting for ${whatLabel} posted after #${params.since} — woke on #${event.message.seq} from @${event.message.agent}.`;
		const body = formatBoardMessagesMarkdown(view.messages);
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
		if (byId.length === 1) {
			return { model: byId[0]!, pattern: `${byId[0]!.provider}/${byId[0]!.id}` };
		}
		if (byId.length > 1) {
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

		// Coordinator creates swarm lazily on first `add`; workers require an existing swarm.
		let roster = (await this.store.getSnapshot()).roster;
		const isTopLevel = (params.session.taskDepth ?? 0) === 0;
		if (!roster) {
			if (!isTopLevel) {
				throw new Error("no swarm yet; only the coordinator can start one");
			}
			roster = await this.ensureCoordinatorSwarm(params.session);
		}
		promoteSwarmToolsOnSession(params.session);

		const actor = this.resolveActorName(params.session, roster);
		const actorRow = roster.members[actor];
		if (!actorRow || actorRow.killed) {
			throw new Error(`this conversation ("${actor}") is not a live member of the swarm`);
		}

		// Validate `fork` source if requested
		let forkFromAgentId: string | undefined;
		let forkFromLabel: string | undefined;
		if (params.fork !== undefined && params.fork.trim() !== "") {
			const forkName = params.fork.trim();
			if (forkName === "coordinator") {
				forkFromAgentId = "coordinator";
				forkFromLabel = "coordinator";
			} else {
				const forkMember = roster.members[forkName];
				if (!forkMember) {
					throw new Error(`cannot fork "${forkName}": no swarm member with that name`);
				}
				forkFromAgentId = forkMember.agent_id;
				forkFromLabel = forkMember.name;
			}
		}

		// Resolve channels (explicit or inherited from adder)
		const channelMap = new Map<string, SwarmChannelInfo>(roster.channels.map(c => [c.name, c]));
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
		} else if (actor !== "coordinator" && actorRow.channels && actorRow.channels.length > 0) {
			const inherited = actorRow.channels.filter(isActiveChannel);
			memberChannels = inherited.length > 0 ? inherited : null;
		}

		const { pattern: modelPattern } = this.resolveSwarmModel(params.session, params.model);

		// Build worker spawn plan (single or `<base>-1..<base>-k`)
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

		const homeChannel = homeChannelIn(memberChannels, isActiveChannel);
		const targetLabel = isGroup ? baseName : planned[0]!.name;
		let publicBriefText = `@${targetLabel} ${trimmedBrief}`;
		if (params.tasks && params.tasks.length > 0) {
			const sliceLines = planned.map(p => `- @${p.name}: ${p.sliceTask}`).join("\n");
			publicBriefText += `\n\nAssigned slices:\n${sliceLines}`;
		}

		const parentPrefix = actor === "coordinator" ? undefined : (params.session.getAgentId?.() ?? actorRow.agent_id);

		const newRows: Array<Omit<SwarmMemberRecord, "last_read_seq" | "wait_since" | "updated_at">> = planned.map(p => {
			// Top-level spawns get `id = p.name`; nested spawns under a worker get `${parentPrefix}.${p.name}` in AgentRegistry.
			const expectedAgentId = parentPrefix ? `${parentPrefix}.${p.name}` : p.name;
			this.#agentIdToMember.set(expectedAgentId, p.name);
			this.#agentIdToMember.set(p.name, p.name);
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

		const { briefMessage, roster: updatedRoster } = await this.store.addMembersWithBrief({
			actor,
			briefText: publicBriefText,
			briefChannel: homeChannel,
			newMembers: newRows,
		});

		// Wake existing observers (e.g. narrator) without re-notifying the brand-new workers
		const rosterWithoutNew: SwarmRosterFile = {
			...updatedRoster,
			members: Object.fromEntries(
				Object.entries(updatedRoster.members).filter(([k]) => !planned.some(p => p.name === k)),
			),
		};
		const senderAgentId = params.session.getAgentId?.() ?? actorRow.agent_id;
		await this.ring(briefMessage, rosterWithoutNew, senderAgentId, params.session.agentRegistry);

		// Launch each worker asynchronously via `runStructuredSubagent`
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
					swarmDir: p.role === "narrator" ? this.store.dir : undefined,
				})
				.trim();

			this.#launchBackgroundWorker({
				parentSession: params.session,
				memberName: p.name,
				expectedAgentId: parentPrefix ? `${parentPrefix}.${p.name}` : p.name,
				bundledAgent,
				assignment,
				modelPattern,
				workspace,
				forkFrom: forkFromAgentId,
				channels: memberChannels ?? undefined,
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
				: ` SWARM_DIR=${this.store.dir} (run \`/swarm board\` at any time to view the live board).`;

		return {
			text: `${spawnedLabel} ${boardLoc}${wsNote}${helperNote}`,
			added: planned.map(p => p.name),
			seq: briefMessage.seq,
			head: briefMessage.seq,
		};
	}

	#launchBackgroundWorker(options: {
		parentSession: ToolSession;
		memberName: string;
		expectedAgentId: string;
		bundledAgent: string;
		assignment: string;
		modelPattern: string;
		workspace: SwarmWorkspaceMode;
		forkFrom?: string;
		channels?: string[];
	}): void {
		const abortController = new AbortController();
		const runRecord: ActiveWorkerRun = {
			memberName: options.memberName,
			agentId: options.expectedAgentId,
			abortController,
			running: true,
		};
		this.#activeRuns.set(options.memberName, runRecord);

		const effectiveSession: ToolSession =
			options.workspace === "share" || options.workspace === "branch"
				? {
						...options.parentSession,
						settings: createSubagentSettings(options.parentSession.settings, {
							"task.isolation.enabled": true,
						}),
						suppressSpawnAdvisory: true,
					}
				: {
						...options.parentSession,
						suppressSpawnAdvisory: true,
					};

		const isolation =
			options.workspace === "share"
				? ({ requested: true, merge: "patch", apply: false } as const)
				: options.workspace === "branch"
					? ({ requested: true, merge: "branch", apply: false } as const)
					: undefined;

		void (async () => {
			try {
				const outcome = await runStructuredSubagent({
					session: effectiveSession,
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
					isolation,
					forkFrom: options.forkFrom,
					channels: options.channels,
					signal: abortController.signal,
				});
				const actualId = outcome.result.id;
				if (actualId && actualId !== options.expectedAgentId) {
					this.#agentIdToMember.set(actualId, options.memberName);
					runRecord.agentId = actualId;
					await this.store.updateMemberFields(options.memberName, { agent_id: actualId });
				}
				const wsNote = outcome.result.branchName
					? `branch:${outcome.result.branchName}`
					: outcome.result.patchPath
						? `patch:${outcome.result.patchPath}`
						: undefined;
				if (outcome.result.exitCode !== 0 && !outcome.result.aborted) {
					const errText = outcome.result.error || outcome.result.stderr || "worker turn failed";
					await this.store.updateMemberFields(options.memberName, {
						last_error: errText.slice(0, 300),
						quota_exhausted: QUOTA_ERROR_RE.test(errText),
						...(wsNote ? { workspace_note: wsNote } : {}),
					});
				} else {
					await this.store.updateMemberFields(options.memberName, {
						last_error: undefined,
						quota_exhausted: false,
						...(wsNote ? { workspace_note: wsNote } : {}),
					});
				}
			} catch (err) {
				if (!abortController.signal.aborted) {
					const msg = err instanceof Error ? err.message : String(err);
					await this.store.updateMemberFields(options.memberName, {
						last_error: msg.slice(0, 300),
						quota_exhausted: QUOTA_ERROR_RE.test(msg),
					});
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
		const snap = await this.store.getSnapshot();
		if (!snap.roster) throw new Error("no swarm yet; add a worker to start one");
		const actor = this.resolveActorName(params.session, snap.roster);

		// Match exact member OR numbered group `<target>-1..<target>-k`
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

		await this.store.markKilled(toKill);
		const lifecycle = params.session.agentLifecycle?.() ?? AgentLifecycleManager.global();
		const reg = params.session.agentRegistry ?? AgentRegistry.global();

		for (const m of groupMatches) {
			const waiters = this.#waiters.get(m.name);
			if (waiters) {
				for (const w of waiters) w.resolve({ kind: "killed" });
				waiters.clear();
			}
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
	}): Promise<{ text: string; target: string; model: string }> {
		const snap = await this.store.getSnapshot();
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

		const reg = params.session.agentRegistry ?? AgentRegistry.global();
		if (!isSelf) {
			const currentStatus = this.memberStatusOf(targetRow, reg);
			if (currentStatus === "working") {
				throw new Error(`worker "${targetName}" is mid-turn; switch its model once status shows it waiting`);
			}
		}

		const { model: resolvedModel, pattern } = this.resolveSwarmModel(params.session, params.model);
		const targetRef = reg.get(targetRow.agent_id);
		if (targetRef?.session && resolvedModel && isLocalAgentSession(targetRef.session)) {
			await targetRef.session.setModel(resolvedModel);
		}

		await this.store.updateMemberFields(targetName, {
			model: pattern,
			quota_exhausted: false,
			last_error: undefined,
		});

		const actorLabel = actor === "coordinator" ? "The coordinator" : `@${actor}`;
		const waiters = this.#waiters.get(targetName);
		if (waiters && waiters.size > 0) {
			for (const w of waiters) {
				w.resolve({
					kind: "model_switch",
					actorLabel,
					selfSwitched: isSelf,
					isCoordinator: targetName === "coordinator",
					model: pattern,
				});
			}
			waiters.clear();
		} else if (!isSelf && targetRef) {
			const notice = prompt
				.render(boardNoticeTemplate, {
					isModelSwitch: true,
					actorLabel,
					selfSwitched: false,
					isCoordinator: targetName === "coordinator",
					model: pattern,
				})
				.trim();
			await IrcBus.global()
				.send({
					from: params.session.getAgentId?.() ?? MAIN_AGENT_ID,
					to: targetRow.agent_id,
					body: notice,
				})
				.catch(() => {});
		}

		return {
			text: isSelf ? `Switched your model to \`${pattern}\`.` : `Switched worker @${targetName} to \`${pattern}\`.`,
			target: targetName,
			model: pattern,
		};
	}

	/** Render `swarm{action:"status"}` markdown. */
	async formatStatusMarkdown(registry?: AgentRegistryApi): Promise<string> {
		const snap = await this.store.getSnapshot();
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
		lines.push(`### Swarm Status${titlePart} (board head: #${snap.head}, dir: \`${this.store.dir}\`)`);
		lines.push("");

		let taskAgents = 0;
		let waitingCount = 0;
		let workingCount = 0;
		let stoppedCount = 0;

		for (const m of members) {
			const status = this.memberStatusOf(m, reg);
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
	async formatMonitorStatusTable(registry?: AgentRegistryApi): Promise<string> {
		const snap = await this.store.getSnapshot();
		if (!snap.roster) {
			return "No swarm yet.";
		}
		const reg = registry ?? AgentRegistry.global();
		const lines = [
			`Swarm status (board #${snap.head}):`,
			"",
			"| member | state | parked on | last post |",
			"|---|---|---|---|",
		];
		for (const m of Object.values(snap.roster.members)) {
			const state = this.memberStatusOf(m, reg);
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
		const snap = await this.store.getSnapshot();
		if (!snap.roster) {
			return "No swarm in this conversation. Start one with `/swarm <task>`.";
		}
		const reg = options?.registry ?? AgentRegistry.global();
		const rosterNames = new Set(Object.keys(snap.roster.members));
		const overview: SwarmOverviewView | null = await this.store.readNarratorOverview(snap.head, rosterNames);

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

		const view = await this.store.readView({
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
