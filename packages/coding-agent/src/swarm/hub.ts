import * as path from "node:path";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import { IrcBus } from "../irc/bus";
import boardNoticeTemplate from "../prompts/swarm/board-notice.md" with { type: "text" };
import { AgentLifecycleManager, type AgentLifecycleApi } from "../registry/agent-lifecycle";
import { AgentRegistry, type AgentRegistryApi, MAIN_AGENT_ID } from "../registry/agent-registry";
import type { AgentSessionHandle } from "../session/agent-session-handle";
import {
	countsAsUnread,
	effectiveChannels,
	isRoleObserver,
	mentionsIn,
	messageChannelOf,
	seesIn,
	SWARM_MAIN_CHANNEL,
} from "./mentions";
import { type ReadViewResult, SwarmBoardStore } from "./store";
import type {
	SwarmAutoParkResult,
	SwarmBoardMessage,
	SwarmChannelInfo,
	SwarmChannelOp,
	SwarmHeadLagResult,
	SwarmMemberRecord,
	SwarmMemberStatus,
	SwarmOverviewView,
	SwarmParkTurnResult,
	SwarmRosterFile,
	SwarmWaitSignalEvent,
	SwarmWakeMode,
} from "./types";

const QUOTA_ERROR_RE = /RESOURCE_EXHAUSTED|quota|\b429\b|exhausted your capacity|rate.?limit/i;

export function isSwarmQuotaError(errorText: string): boolean {
	return QUOTA_ERROR_RE.test(errorText);
}
/** Payload sent by {@link SwarmHub} to wake an idle/parked session via {@link AgentSessionHandle.deliverSwarmWake}. */
export interface SwarmWakeNotice {
	readonly swarmDir: string;
	readonly text: string;
	readonly headSeq?: number;
	readonly isTimeout?: boolean;
	readonly isModelSwitch?: boolean;
}

export interface SwarmAddMembersInput {
	readonly actor: string;
	readonly senderAgentId?: string;
	readonly briefText: string;
	readonly briefChannel: string;
	readonly newMembers: Array<Omit<SwarmMemberRecord, "last_read_seq" | "wait_since" | "updated_at">>;
}
export interface SwarmEnsureInput {
	readonly coordinatorAgentId: string;
	readonly coordinatorConversationId: string;
	readonly model: string;
	readonly title?: string;
}

export interface SwarmPostInput {
	readonly actor: string;
	readonly text: string;
	readonly channel?: string;
	readonly senderAgentId?: string;
}

export interface SwarmWaitSignalInput {
	readonly memberName: string;
	readonly since: number;
	readonly mentionsOnly: boolean;
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
}

export interface SwarmParkTurnInput {
	readonly memberName: string;
	readonly since: number;
	readonly mentionsOnly: boolean;
	readonly timeoutMs?: number;
}

export interface SwarmModelSwitchNotifyInput {
	readonly memberName: string;
	readonly targetAgentId: string;
	readonly actor: string;
	readonly selfSwitch: boolean;
	readonly modelLabel: string;
}

export interface SwarmSnapshotResult {
	readonly roster: SwarmRosterFile | null;
	readonly messages: SwarmBoardMessage[];
	readonly head: number;
}

/**
 * Process-authoritative Swarm Hub API.
 *
 * Lives on the main thread; Bun worker threads install a proxy
 * (`RemoteSwarmHub` via `swarmThreadService`) so `board.jsonl`, `members.json`,
 * wait parking, wake timers, and turn doorbells execute under one authority.
 */
export interface SwarmHubApi {
	ensureCoordinatorSwarm(swarmDir: string, params: SwarmEnsureInput): Promise<SwarmRosterFile>;
	getSnapshot(swarmDir: string): Promise<SwarmSnapshotResult>;
	setTitle(swarmDir: string, actor: string, title: string): Promise<SwarmRosterFile>;
	addMembersWithBrief(
		swarmDir: string,
		params: SwarmAddMembersInput,
	): Promise<{ roster: SwarmRosterFile; briefMessage: SwarmBoardMessage }>;
	postMessage(
		swarmDir: string,
		params: SwarmPostInput,
	): Promise<{ message: SwarmBoardMessage; roster: SwarmRosterFile; warnings: string[] }>;
	readView(
		swarmDir: string,
		params: {
			readonly memberName: string;
			readonly since?: number;
			readonly limit?: number;
			readonly seqs?: number[];
			readonly channel?: string;
			readonly advanceCursor?: boolean;
		},
	): Promise<ReadViewResult>;
	readNarratorOverview(swarmDir: string, head: number, memberNames: string[]): Promise<SwarmOverviewView | null>;
	executeChannelOp(
		swarmDir: string,
		params: {
			readonly actor: string;
			readonly op: SwarmChannelOp;
			readonly channel?: string;
			readonly topic?: string;
			readonly targetMember?: string;
		},
	): Promise<{ text: string; roster: SwarmRosterFile; message?: SwarmBoardMessage }>;
	markKilled(swarmDir: string, names: readonly string[]): Promise<SwarmRosterFile | null>;
	updateMemberFields(
		swarmDir: string,
		memberName: string,
		patch: Partial<
			Pick<
				SwarmMemberRecord,
				"model" | "last_error" | "quota_exhausted" | "sit_out_until_seq" | "workspace_note" | "agent_id"
			>
		>,
	): Promise<SwarmMemberRecord | null>;
	recordWait(swarmDir: string, memberName: string, since: number, wakeMode: SwarmWakeMode): Promise<void>;
	registerAgentBinding(swarmDir: string, agentId: string, memberName: string): void;
	resolveActorName(swarmDir: string, agentId: string, taskDepth: number, explicitMemberName?: string): Promise<string>;
	checkHeadLag(swarmDir: string, memberName: string, seenHeadWatermark: number): Promise<SwarmHeadLagResult>;
	parkMemberTurn(swarmDir: string, params: SwarmParkTurnInput): Promise<SwarmParkTurnResult>;
	checkAutoParkOnStop(
		swarmDir: string,
		params: { readonly memberName: string; readonly isWorker: boolean },
	): Promise<SwarmAutoParkResult>;
	waitForBoardSignal(swarmDir: string, params: SwarmWaitSignalInput): Promise<SwarmWaitSignalEvent>;
	notifyModelSwitched(swarmDir: string, params: SwarmModelSwitchNotifyInput): Promise<void>;
	notifyKilled(swarmDir: string, memberName: string): void;
	isParked(swarmDir: string, memberName: string): Promise<boolean>;
	waitUntilParked(swarmDir: string, memberName: string): Promise<void>;
	getMemberStatus(swarmDir: string, member: SwarmMemberRecord): SwarmMemberStatus;
	hasActiveSwarmMembers(swarmDir: string): Promise<boolean>;
	reportMemberTurnError(swarmDir: string, memberName: string, errorText: string, isQuota: boolean): Promise<void>;
	clearMemberError(swarmDir: string, memberName: string): Promise<void>;
}

interface SwarmWaiter {
	readonly memberName: string;
	readonly since: number;
	readonly mentionsOnly: boolean;
	readonly resolve: (event: SwarmWaitSignalEvent) => void;
}

interface ParkedTurnEntry {
	readonly memberName: string;
	readonly since: number;
	readonly mentionsOnly: boolean;
	timer?: NodeJS.Timeout;
}

interface DirState {
	readonly store: SwarmBoardStore;
	readonly waiters: Map<string, Set<SwarmWaiter>>;
	readonly parkedTurns: Map<string, ParkedTurnEntry>;
	readonly parkedListeners: Map<string, Set<() => void>>;
	readonly agentIdToMember: Map<string, string>;
}

type SwarmDeliverSessionHandle = AgentSessionHandle & {
	deliverSwarmWake?: (notice: SwarmWakeNotice) => Promise<void>;
};

let globalHub: SwarmHubApi | undefined;

function buildChannelLookup(roster: SwarmRosterFile): (ch: string) => boolean {
	const channelMap = new Map<string, SwarmChannelInfo>(roster.channels.map(c => [c.name, c]));
	return (ch: string) => {
		const info = channelMap.get(ch);
		return Boolean(info && !info.archived);
	};
}

function isConcerningMessage(
	member: SwarmMemberRecord,
	message: SwarmBoardMessage,
	mentionsOnly: boolean,
	isActiveChannel: (ch: string) => boolean,
): boolean {
	if (message.agent === member.name) return false;
	const memberSet = effectiveChannels(member.role, member.channels, member.name);
	if (!mentionsOnly) {
		return seesIn(member.name, memberSet, message, isActiveChannel) && countsAsUnread(message);
	}
	return mentionsIn(message.text, member.name, memberSet, isActiveChannel);
}

function findConcerningAfterInSnapshot(
	snap: SwarmSnapshotResult,
	member: SwarmMemberRecord,
	since: number,
	mentionsOnly: boolean,
): SwarmBoardMessage[] {
	if (!snap.roster) return [];
	const isActiveChannel = buildChannelLookup(snap.roster);
	return snap.messages.filter(
		msg => msg.seq > since && isConcerningMessage(member, msg, mentionsOnly, isActiveChannel),
	);
}

function renderMessageWakeText(message: SwarmBoardMessage, lastReadSeq: number, headSeq: number): string {
	const preview = message.text.length > 240 ? `${message.text.slice(0, 239).trimEnd()}…` : message.text;
	const ch = messageChannelOf(message);
	return prompt
		.render(boardNoticeTemplate, {
			isModelSwitch: false,
			seq: message.seq,
			sender: message.agent,
			channelTag: ch !== SWARM_MAIN_CHANNEL ? `#${ch}` : undefined,
			preview,
			headSeq,
			lastReadSeq,
		})
		.trim();
}

function renderModelSwitchWakeText(params: {
	actorLabel: string;
	selfSwitched: boolean;
	isCoordinator: boolean;
	model: string;
}): string {
	return prompt
		.render(boardNoticeTemplate, {
			isModelSwitch: true,
			actorLabel: params.actorLabel,
			selfSwitched: params.selfSwitched,
			isCoordinator: params.isCoordinator,
			model: params.model,
		})
		.trim();
}

function renderTimeoutWakeText(timeoutMs: number, headSeq: number, lastReadSeq: number): string {
	return prompt
		.render(boardNoticeTemplate, {
			isTimeout: true,
			timeoutMs,
			headSeq,
			lastReadSeq,
		})
		.trim();
}

/**
 * Main-thread authoritative SwarmHub coordinating every active swarm directory
 * across in-process and Bun-worker sessions.
 */
export class SwarmHub implements SwarmHubApi {
	static global(): SwarmHubApi {
		globalHub ??= new SwarmHub();
		return globalHub;
	}

	static installGlobal(api: SwarmHubApi): void {
		globalHub = api;
	}

	static resetGlobalForTests(): void {
		if (globalHub instanceof SwarmHub) {
			globalHub.disposeForTests();
		}
		globalHub = undefined;
		SwarmBoardStore.resetForTests();
	}

	readonly #dirs = new Map<string, DirState>();
	readonly #registryOverride: AgentRegistryApi | undefined;
	readonly #lifecycleOverride: AgentLifecycleApi | undefined;

	constructor(options?: { registry?: AgentRegistryApi; lifecycle?: AgentLifecycleApi }) {
		this.#registryOverride = options?.registry;
		this.#lifecycleOverride = options?.lifecycle;
	}

	#registry(): AgentRegistryApi {
		return this.#registryOverride ?? AgentRegistry.global();
	}

	#lifecycle(): AgentLifecycleApi {
		return this.#lifecycleOverride ?? AgentLifecycleManager.global();
	}

	#dir(swarmDir: string): DirState {
		const resolved = path.resolve(swarmDir);
		let entry = this.#dirs.get(resolved);
		if (!entry) {
			entry = {
				store: SwarmBoardStore.forDir(resolved),
				waiters: new Map(),
				parkedTurns: new Map(),
				parkedListeners: new Map(),
				agentIdToMember: new Map(),
			};
			this.#dirs.set(resolved, entry);
		}
		return entry;
	}

	disposeForTests(): void {
		for (const state of this.#dirs.values()) {
			for (const entry of state.parkedTurns.values()) {
				clearTimeout(entry.timer);
			}
			state.parkedTurns.clear();
			for (const set of state.waiters.values()) {
				for (const waiter of set) {
					waiter.resolve({ kind: "killed" });
				}
				set.clear();
			}
			state.waiters.clear();
			state.parkedListeners.clear();
			state.agentIdToMember.clear();
		}
		this.#dirs.clear();
	}

	async ensureCoordinatorSwarm(swarmDir: string, params: SwarmEnsureInput): Promise<SwarmRosterFile> {
		const state = this.#dir(swarmDir);
		const roster = await state.store.ensureSwarm({
			coordinatorAgentId: params.coordinatorAgentId,
			coordinatorConversationId: params.coordinatorConversationId,
			model: params.model,
			title: params.title,
		});
		state.agentIdToMember.set(params.coordinatorAgentId, "coordinator");
		return roster;
	}

	async getSnapshot(swarmDir: string): Promise<SwarmSnapshotResult> {
		return this.#dir(swarmDir).store.getSnapshot();
	}

	async setTitle(swarmDir: string, actor: string, title: string): Promise<SwarmRosterFile> {
		return this.#dir(swarmDir).store.setTitle(actor, title);
	}

	async addMembersWithBrief(
		swarmDir: string,
		params: SwarmAddMembersInput,
	): Promise<{ roster: SwarmRosterFile; briefMessage: SwarmBoardMessage }> {
		const state = this.#dir(swarmDir);
		const res = await state.store.addMembersWithBrief({
			actor: params.actor,
			briefText: params.briefText,
			briefChannel: params.briefChannel,
			newMembers: params.newMembers,
		});
		const newNames = new Set<string>();
		for (const m of params.newMembers) {
			state.agentIdToMember.set(m.agent_id, m.name);
			state.agentIdToMember.set(m.name, m.name);
			newNames.add(m.name);
		}
		// Wake pre-existing observers (e.g. narrator/monitor) without ringing newly added workers twice.
		const rosterWithoutNew: SwarmRosterFile = {
			...res.roster,
			members: Object.fromEntries(Object.entries(res.roster.members).filter(([name]) => !newNames.has(name))),
		};
		const senderId = params.senderAgentId ?? res.roster.members[params.actor]?.agent_id ?? MAIN_AGENT_ID;
		await this.#ring(swarmDir, state, res.briefMessage, rosterWithoutNew, senderId);
		return res;
	}

	async postMessage(
		swarmDir: string,
		params: SwarmPostInput,
	): Promise<{ message: SwarmBoardMessage; roster: SwarmRosterFile; warnings: string[] }> {
		const state = this.#dir(swarmDir);
		const res = await state.store.postMessage({
			author: params.actor,
			text: params.text,
			channel: params.channel,
			kind: "post",
		});
		// Warn sender if any explicitly @mentioned peer is quota-exhausted so the
		// coordinator knows to call `swarm{action:"model"}` instead of polling indefinitely.
		const extraWarnings: string[] = [];
		const channelMap = buildChannelLookup(res.roster);
		for (const member of Object.values(res.roster.members)) {
			if (!member.quota_exhausted || member.killed || member.name === params.actor) continue;
			const memberSet = effectiveChannels(member.role, member.channels, member.name);
			if (mentionsIn(params.text, member.name, memberSet, channelMap)) {
				extraWarnings.push(
					`@${member.name} has exhausted its model quota; switch its model via swarm{action:"model", name:"${member.name}", model:"..."} to resume it`,
				);
			}
		}
		const senderId = params.senderAgentId ?? res.roster.members[params.actor]?.agent_id ?? MAIN_AGENT_ID;
		await this.#ring(swarmDir, state, res.message, res.roster, senderId);
		return {
			message: res.message,
			roster: res.roster,
			warnings: [...res.warnings, ...extraWarnings],
		};
	}

	async readView(
		swarmDir: string,
		params: {
			readonly memberName: string;
			readonly since?: number;
			readonly limit?: number;
			readonly seqs?: number[];
			readonly channel?: string;
			readonly advanceCursor?: boolean;
		},
	): Promise<ReadViewResult> {
		return this.#dir(swarmDir).store.readView({
			memberName: params.memberName,
			since: params.since,
			limit: params.limit,
			seqs: params.seqs,
			channel: params.channel,
			advanceCursor: params.advanceCursor,
		});
	}

	async readNarratorOverview(
		swarmDir: string,
		head: number,
		memberNames: string[],
	): Promise<SwarmOverviewView | null> {
		return this.#dir(swarmDir).store.readNarratorOverview(head, new Set(memberNames));
	}

	async executeChannelOp(
		swarmDir: string,
		params: {
			readonly actor: string;
			readonly op: SwarmChannelOp;
			readonly channel?: string;
			readonly topic?: string;
			readonly targetMember?: string;
		},
	): Promise<{ text: string; roster: SwarmRosterFile; message?: SwarmBoardMessage }> {
		const state = this.#dir(swarmDir);
		const res = await state.store.executeChannelOp({
			actor: params.actor,
			op: params.op,
			channel: params.channel,
			topic: params.topic,
			targetMember: params.targetMember,
		});
		if (res.message) {
			const senderId = res.roster.members[params.actor]?.agent_id ?? MAIN_AGENT_ID;
			await this.#ring(swarmDir, state, res.message, res.roster, senderId);
		}
		return res;
	}

	async markKilled(swarmDir: string, names: readonly string[]): Promise<SwarmRosterFile | null> {
		const state = this.#dir(swarmDir);
		const roster = await state.store.markKilled(names);
		for (const name of names) {
			this.#notifyKilledState(state, name);
		}
		return roster;
	}

	async updateMemberFields(
		swarmDir: string,
		memberName: string,
		patch: Partial<
			Pick<
				SwarmMemberRecord,
				"model" | "last_error" | "quota_exhausted" | "sit_out_until_seq" | "workspace_note" | "agent_id"
			>
		>,
	): Promise<SwarmMemberRecord | null> {
		const state = this.#dir(swarmDir);
		const row = await state.store.updateMemberFields(memberName, patch);
		if (patch.agent_id) {
			state.agentIdToMember.set(patch.agent_id, memberName);
		}
		return row;
	}

	async recordWait(swarmDir: string, memberName: string, since: number, wakeMode: SwarmWakeMode): Promise<void> {
		await this.#dir(swarmDir).store.recordWait(memberName, since, wakeMode);
	}

	registerAgentBinding(swarmDir: string, agentId: string, memberName: string): void {
		this.#dir(swarmDir).agentIdToMember.set(agentId, memberName);
	}

	async resolveActorName(
		swarmDir: string,
		agentId: string,
		taskDepth: number,
		explicitMemberName?: string,
	): Promise<string> {
		if (explicitMemberName) return explicitMemberName;
		if (taskDepth === 0 || agentId === MAIN_AGENT_ID) return "coordinator";
		const state = this.#dir(swarmDir);
		const cached = state.agentIdToMember.get(agentId);
		if (cached) return cached;
		const snap = await state.store.getSnapshot();
		if (snap.roster) {
			if (snap.roster.members[agentId]) {
				state.agentIdToMember.set(agentId, agentId);
				return agentId;
			}
			for (const member of Object.values(snap.roster.members)) {
				if (member.agent_id === agentId || agentId.endsWith(`.${member.name}`)) {
					state.agentIdToMember.set(agentId, member.name);
					return member.name;
				}
			}
		}
		return agentId;
	}

	async checkHeadLag(swarmDir: string, memberName: string, seenHeadWatermark: number): Promise<SwarmHeadLagResult> {
		const snap = await this.#dir(swarmDir).store.getSnapshot();
		if (!snap.roster) {
			return { head: snap.head, lastReadSeq: 0, hasUnreadVisible: false, hasConcerning: false };
		}
		const member = snap.roster.members[memberName];
		if (!member || member.killed) {
			return { head: snap.head, lastReadSeq: 0, hasUnreadVisible: false, hasConcerning: false };
		}
		if (snap.head <= member.last_read_seq || snap.head <= seenHeadWatermark) {
			return {
				head: snap.head,
				lastReadSeq: member.last_read_seq,
				hasUnreadVisible: false,
				hasConcerning: false,
			};
		}
		const isActiveChannel = buildChannelLookup(snap.roster);
		const memberSet = effectiveChannels(member.role, member.channels, member.name);
		let hasUnreadVisible = false;
		let firstConcerningSeq: number | undefined;
		const wakeMentionsOnly = member.wake_mode !== "anything";
		for (const msg of snap.messages) {
			if (msg.seq <= member.last_read_seq || msg.agent === memberName) continue;
			if (seesIn(member.name, memberSet, msg, isActiveChannel) && countsAsUnread(msg)) {
				hasUnreadVisible = true;
			}
			if (firstConcerningSeq === undefined && isConcerningMessage(member, msg, wakeMentionsOnly, isActiveChannel)) {
				firstConcerningSeq = msg.seq;
			}
		}
		return {
			head: snap.head,
			lastReadSeq: member.last_read_seq,
			hasUnreadVisible,
			hasConcerning: firstConcerningSeq !== undefined,
			firstConcerningSeq,
		};
	}

	async parkMemberTurn(swarmDir: string, params: SwarmParkTurnInput): Promise<SwarmParkTurnResult> {
		const state = this.#dir(swarmDir);
		const wakeMode: SwarmWakeMode = params.mentionsOnly ? "mentions" : "anything";
		const initialSnap = await state.store.getSnapshot();
		if (!initialSnap.roster) {
			throw new Error("no swarm yet; add a worker to start one");
		}
		const member = initialSnap.roster.members[params.memberName];
		if (!member) {
			throw new Error(`this conversation ("${params.memberName}") is not a member of the swarm`);
		}
		if (member.killed) {
			throw new Error(`"${params.memberName}" was killed and cannot wait on the board`);
		}

		// WaitCheck before parking: return immediately if concerning posts already landed.
		const immediate = findConcerningAfterInSnapshot(initialSnap, member, params.since, params.mentionsOnly);
		if (immediate.length > 0) {
			return {
				parked: false,
				head: initialSnap.head,
				immediate: {
					head: initialSnap.head,
					matching: immediate,
					lastReadSeq: member.last_read_seq,
				},
			};
		}

		await state.store.recordWait(params.memberName, params.since, wakeMode);

		// Re-check after lock acquisition in case a concurrent post landed mid-flight.
		const recheckSnap = await state.store.getSnapshot();
		const updatedMember = recheckSnap.roster?.members[params.memberName] ?? member;
		const raced = findConcerningAfterInSnapshot(recheckSnap, updatedMember, params.since, params.mentionsOnly);
		if (raced.length > 0) {
			return {
				parked: false,
				head: recheckSnap.head,
				immediate: {
					head: recheckSnap.head,
					matching: raced,
					lastReadSeq: updatedMember.last_read_seq,
				},
			};
		}

		this.#clearParkedTurn(state, params.memberName);
		const parkedEntry: ParkedTurnEntry = {
			memberName: params.memberName,
			since: params.since,
			mentionsOnly: params.mentionsOnly,
		};
		if (params.timeoutMs && params.timeoutMs > 0) {
			const timeoutMs = params.timeoutMs;
			const resolvedDir = path.resolve(swarmDir);
			parkedEntry.timer = setTimeout(() => {
				void this.#handleParkedTimeout(resolvedDir, params.memberName, timeoutMs);
			}, timeoutMs);
			parkedEntry.timer.unref?.();
		}
		state.parkedTurns.set(params.memberName, parkedEntry);
		this.#notifyParkedListeners(state, params.memberName);
		return { parked: true, head: recheckSnap.head };
	}

	async checkAutoParkOnStop(
		swarmDir: string,
		params: { readonly memberName: string; readonly isWorker: boolean },
	): Promise<SwarmAutoParkResult> {
		const state = this.#dir(swarmDir);
		const snap = await state.store.getSnapshot();
		if (!snap.roster) {
			return { parked: false, callsOnYou: false, hasUnread: false, head: snap.head, lastReadSeq: 0 };
		}
		const member = snap.roster.members[params.memberName];
		if (!member || member.killed) {
			return { parked: false, callsOnYou: false, hasUnread: false, head: snap.head, lastReadSeq: 0 };
		}
		const isActiveChannel = buildChannelLookup(snap.roster);
		const unread = snap.messages.filter(
			msg =>
				msg.seq > member.last_read_seq &&
				msg.agent !== member.name &&
				seesIn(member.name, effectiveChannels(member.role, member.channels, member.name), msg, isActiveChannel) &&
				countsAsUnread(msg),
		);
		const callsOnYou = unread.some(msg => isConcerningMessage(member, msg, true, isActiveChannel));
		const hasUnread = unread.length > 0;

		if (callsOnYou) {
			return {
				parked: false,
				callsOnYou: true,
				hasUnread: true,
				head: snap.head,
				lastReadSeq: member.last_read_seq,
			};
		}

		if (params.isWorker && member.wake_mode === "anything" && hasUnread) {
			return {
				parked: false,
				callsOnYou: true,
				hasUnread: true,
				head: snap.head,
				lastReadSeq: member.last_read_seq,
			};
		}

		if (params.isWorker) {
			await state.store.recordWait(member.name, member.last_read_seq, member.wake_mode);
			const recheck = await state.store.getSnapshot();
			const freshMember = recheck.roster?.members[member.name] ?? member;
			const mentionsOnly = freshMember.wake_mode !== "anything";
			const raced = findConcerningAfterInSnapshot(recheck, freshMember, freshMember.last_read_seq, mentionsOnly);
			if (raced.length > 0) {
				return {
					parked: false,
					callsOnYou: true,
					hasUnread: true,
					head: recheck.head,
					lastReadSeq: freshMember.last_read_seq,
				};
			}
			this.#clearParkedTurn(state, member.name);
			state.parkedTurns.set(member.name, {
				memberName: member.name,
				since: freshMember.last_read_seq,
				mentionsOnly,
			});
			this.#notifyParkedListeners(state, member.name);
			return {
				parked: true,
				callsOnYou: false,
				hasUnread,
				head: recheck.head,
				lastReadSeq: freshMember.last_read_seq,
			};
		}

		return {
			parked: false,
			callsOnYou: false,
			hasUnread,
			head: snap.head,
			lastReadSeq: member.last_read_seq,
		};
	}

	async waitForBoardSignal(swarmDir: string, params: SwarmWaitSignalInput): Promise<SwarmWaitSignalEvent> {
		const state = this.#dir(swarmDir);
		const snap = await state.store.getSnapshot();
		if (!snap.roster) {
			throw new Error("no swarm yet; add a worker to start one");
		}
		const member = snap.roster.members[params.memberName];
		if (!member) {
			throw new Error(`this conversation ("${params.memberName}") is not a member of the swarm`);
		}
		if (member.killed) {
			throw new Error(`"${params.memberName}" was killed and cannot wait on the board`);
		}

		const immediate = findConcerningAfterInSnapshot(snap, member, params.since, params.mentionsOnly);
		if (immediate.length > 0) {
			return {
				kind: "message",
				message: immediate[immediate.length - 1]!,
				head: snap.head,
				lastReadSeq: member.last_read_seq,
				immediate: true,
			};
		}

		const wakeMode: SwarmWakeMode = params.mentionsOnly ? "mentions" : "anything";
		await state.store.recordWait(params.memberName, params.since, wakeMode);

		const recheckSnap = await state.store.getSnapshot();
		const freshMember = recheckSnap.roster?.members[params.memberName] ?? member;
		const raced = findConcerningAfterInSnapshot(recheckSnap, freshMember, params.since, params.mentionsOnly);
		if (raced.length > 0) {
			return {
				kind: "message",
				message: raced[raced.length - 1]!,
				head: recheckSnap.head,
				lastReadSeq: freshMember.last_read_seq,
				immediate: true,
			};
		}

		if (params.signal?.aborted) {
			return { kind: "aborted", head: recheckSnap.head };
		}

		const { promise, resolve } = Promise.withResolvers<SwarmWaitSignalEvent>();
		const waiter: SwarmWaiter = {
			memberName: params.memberName,
			since: params.since,
			mentionsOnly: params.mentionsOnly,
			resolve,
		};
		let set = state.waiters.get(params.memberName);
		if (!set) {
			set = new Set();
			state.waiters.set(params.memberName, set);
		}
		set.add(waiter);
		this.#notifyParkedListeners(state, params.memberName);

		let timer: NodeJS.Timeout | undefined;
		if (params.timeoutMs && params.timeoutMs > 0) {
			timer = setTimeout(() => {
				set?.delete(waiter);
				void state.store.getSnapshot().then(
					after => {
						const cur = after.roster?.members[params.memberName];
						resolve({ kind: "timeout", head: after.head, lastReadSeq: cur?.last_read_seq ?? params.since });
					},
					() => resolve({ kind: "timeout", head: recheckSnap.head, lastReadSeq: params.since }),
				);
			}, params.timeoutMs);
			timer.unref?.();
		}

		const onAbort = () => {
			set?.delete(waiter);
			resolve({ kind: "aborted", head: recheckSnap.head });
		};
		params.signal?.addEventListener("abort", onAbort, { once: true });

		try {
			return await promise;
		} finally {
			clearTimeout(timer);
			params.signal?.removeEventListener("abort", onAbort);
			set.delete(waiter);
		}
	}

	async notifyModelSwitched(swarmDir: string, params: SwarmModelSwitchNotifyInput): Promise<void> {
		const state = this.#dir(swarmDir);
		await state.store.updateMemberFields(params.memberName, {
			model: params.modelLabel,
			quota_exhausted: false,
			sit_out_until_seq: undefined,
			last_error: undefined,
		});
		const snap = await state.store.getSnapshot();
		const member = snap.roster?.members[params.memberName];
		const actorLabel = params.actor === "coordinator" ? "The coordinator" : `@${params.actor}`;
		const noticeText = renderModelSwitchWakeText({
			actorLabel,
			selfSwitched: params.selfSwitch,
			isCoordinator: params.memberName === "coordinator",
			model: params.modelLabel,
		});

		const waiters = state.waiters.get(params.memberName);
		if (waiters && waiters.size > 0) {
			for (const w of waiters) {
				w.resolve({ kind: "model_switch", text: noticeText, head: snap.head });
			}
			waiters.clear();
			return;
		}

		const wasParked = state.parkedTurns.has(params.memberName);
		this.#clearParkedTurn(state, params.memberName);

		if (
			!params.selfSwitch &&
			member &&
			!member.killed &&
			(wasParked || this.getMemberStatus(swarmDir, member) !== "working")
		) {
			await this.#deliverNoticeToMember(
				swarmDir,
				member,
				{
					swarmDir,
					text: noticeText,
					headSeq: snap.head,
					isModelSwitch: true,
				},
				params.actor === "coordinator" ? MAIN_AGENT_ID : params.actor,
			);
		}
	}

	notifyKilled(swarmDir: string, memberName: string): void {
		this.#notifyKilledState(this.#dir(swarmDir), memberName);
	}

	async isParked(swarmDir: string, memberName: string): Promise<boolean> {
		const state = this.#dir(swarmDir);
		if ((state.waiters.get(memberName)?.size ?? 0) > 0) return true;
		if (state.parkedTurns.has(memberName)) return true;
		return false;
	}

	async waitUntilParked(swarmDir: string, memberName: string): Promise<void> {
		if (await this.isParked(swarmDir, memberName)) return;
		const state = this.#dir(swarmDir);
		const { promise, resolve } = Promise.withResolvers<void>();
		let listeners = state.parkedListeners.get(memberName);
		if (!listeners) {
			listeners = new Set();
			state.parkedListeners.set(memberName, listeners);
		}
		listeners.add(resolve);
		return promise;
	}

	getMemberStatus(swarmDir: string, member: SwarmMemberRecord): SwarmMemberStatus {
		if (member.killed) return "killed";
		const state = this.#dir(swarmDir);
		const waiters = state.waiters.get(member.name);
		if (waiters && waiters.size > 0) return "waiting";
		const reg = this.#registry();
		const ref = reg.get(member.agent_id);
		if (state.parkedTurns.has(member.name) && !ref?.session?.isStreaming) {
			return "waiting";
		}
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

	async hasActiveSwarmMembers(swarmDir: string): Promise<boolean> {
		const snap = await this.#dir(swarmDir).store.getSnapshot();
		if (!snap.roster) return false;
		for (const m of Object.values(snap.roster.members)) {
			if (m.name === "coordinator" || m.killed) continue;
			if (isRoleObserver(m.name, m.role)) continue;
			const status = this.getMemberStatus(swarmDir, m);
			if (status === "working") return true;
		}
		return false;
	}

	async reportMemberTurnError(
		swarmDir: string,
		memberName: string,
		errorText: string,
		isQuota: boolean,
	): Promise<void> {
		const state = this.#dir(swarmDir);
		const snap = await state.store.getSnapshot();
		this.#clearParkedTurn(state, memberName);
		await state.store.updateMemberFields(memberName, {
			last_error: errorText.slice(0, 300),
			quota_exhausted: isQuota,
			...(isQuota ? { sit_out_until_seq: snap.head } : {}),
		});
	}

	async clearMemberError(swarmDir: string, memberName: string): Promise<void> {
		await this.#dir(swarmDir).store.updateMemberFields(memberName, {
			last_error: undefined,
			quota_exhausted: false,
			sit_out_until_seq: undefined,
		});
	}

	#clearParkedTurn(state: DirState, memberName: string): void {
		const existing = state.parkedTurns.get(memberName);
		clearTimeout(existing?.timer);
		state.parkedTurns.delete(memberName);
	}

	#notifyParkedListeners(state: DirState, memberName: string): void {
		const listeners = state.parkedListeners.get(memberName);
		if (!listeners) return;
		for (const notify of listeners) notify();
		listeners.clear();
	}

	#notifyKilledState(state: DirState, memberName: string): void {
		this.#clearParkedTurn(state, memberName);
		const waiters = state.waiters.get(memberName);
		if (waiters) {
			for (const w of waiters) w.resolve({ kind: "killed" });
			waiters.clear();
		}
		state.parkedListeners.delete(memberName);
	}

	async #handleParkedTimeout(swarmDir: string, memberName: string, timeoutMs: number): Promise<void> {
		const state = this.#dir(swarmDir);
		const parked = state.parkedTurns.get(memberName);
		if (!parked) return;
		state.parkedTurns.delete(memberName);
		const snap = await state.store.getSnapshot();
		const member = snap.roster?.members[memberName];
		if (!member || member.killed || member.quota_exhausted) return;
		const text = renderTimeoutWakeText(timeoutMs, snap.head, member.last_read_seq);
		await this.#deliverNoticeToMember(
			swarmDir,
			member,
			{ swarmDir, text, headSeq: snap.head, isTimeout: true },
			MAIN_AGENT_ID,
		);
	}

	async #ring(
		swarmDir: string,
		state: DirState,
		message: SwarmBoardMessage,
		roster: SwarmRosterFile,
		senderAgentId: string,
	): Promise<void> {
		const isActiveChannel = buildChannelLookup(roster);
		const wakePromises: Promise<unknown>[] = [];
		const resolvedDir = path.resolve(swarmDir);

		for (const member of Object.values(roster.members)) {
			if (member.killed || member.name === message.agent) continue;
			const mentionsOnly = member.wake_mode !== "anything";
			if (!isConcerningMessage(member, message, mentionsOnly, isActiveChannel)) continue;

			// Quota-exhausted members sit out board chimes until their model is switched.
			if (member.quota_exhausted) continue;

			// 1. In-tool waiters (coordinator `swarm_wait`) wake directly in memory.
			const waiters = state.waiters.get(member.name);
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

			// 2. Parked-on-yield workers (`swarm_wait` or auto-park) AND idle/stopped sessions.
			const parkedEntry = state.parkedTurns.get(member.name);
			if (parkedEntry && message.seq > parkedEntry.since) {
				this.#clearParkedTurn(state, member.name);
				const text = renderMessageWakeText(message, member.last_read_seq, message.seq);
				wakePromises.push(
					this.#deliverNoticeToMember(
						resolvedDir,
						member,
						{ swarmDir: resolvedDir, text, headSeq: message.seq },
						senderAgentId,
					),
				);
				continue;
			}

			const status = this.getMemberStatus(resolvedDir, member);
			if (status === "waiting" || status === "stopped") {
				const text = renderMessageWakeText(message, member.last_read_seq, message.seq);
				wakePromises.push(
					this.#deliverNoticeToMember(
						resolvedDir,
						member,
						{ swarmDir: resolvedDir, text, headSeq: message.seq },
						senderAgentId,
					),
				);
			}
		}

		if (wakePromises.length > 0) {
			await Promise.allSettled(wakePromises);
		}
	}

	async #deliverNoticeToMember(
		swarmDir: string,
		member: SwarmMemberRecord,
		notice: SwarmWakeNotice,
		senderAgentId: string,
	): Promise<void> {
		const reg = this.#registry();
		let ref = reg.get(member.agent_id);
		if (!ref) return;

		if (!ref.session && ref.status === "parked") {
			try {
				await this.#lifecycle().ensureLive(member.agent_id);
				ref = reg.get(member.agent_id);
			} catch (err) {
				logger.debug("SwarmHub: failed to revive parked member", {
					member: member.name,
					agentId: member.agent_id,
					error: String(err),
				});
				return;
			}
		}

		const handle = ref?.session as SwarmDeliverSessionHandle | null | undefined;
		if (!handle) return;

		try {
			if (typeof handle.deliverSwarmWake === "function") {
				await handle.deliverSwarmWake(notice);
				return;
			}
			// Fallback ONLY for unit-test stubs that provide `deliverIrcMessage` without `deliverSwarmWake`.
			await IrcBus.global().send({
				from: senderAgentId,
				to: member.agent_id,
				body: notice.text,
			});
		} catch (err) {
			logger.debug("SwarmHub: failed to wake swarm member", {
				member: member.name,
				agentId: member.agent_id,
				error: String(err),
			});
		}
	}
}
