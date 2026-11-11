import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, isRecord, Snowflake } from "@oh-my-pi/pi-utils";
import {
	checkChannelMentions,
	countsAsUnread,
	effectiveChannels,
	effectiveRole,
	homeChannelIn,
	MAX_CHANNEL_TOPIC_BYTES,
	messageChannelOf,
	normalizeChannelSelector,
	seesIn,
	SWARM_ALL_CHANNELS,
	SWARM_MAIN_CHANNEL,
	validateChannelName,
} from "./mentions";
import type {
	SwarmAttentionItem,
	SwarmAttentionKind,
	SwarmAttentionSeverity,
	SwarmBoardMessage,
	SwarmChannelInfo,
	SwarmMemberRecord,
	SwarmNoteItem,
	SwarmOverviewView,
	SwarmRef,
	SwarmRosterFile,
	SwarmWakeMode,
	SwarmWorkstreamItem,
	SwarmWorkstreamState,
} from "./types";

const BOARD_FILE = "board.jsonl";
const MEMBERS_FILE = "members.json";
const VIEW_JSON_FILE = "view.json";

export const MAX_POST_BYTES = 32 * 1024;
export const VIEW_MAX_BYTES = 64 * 1024;
const RATE_LIMIT_PER_MINUTE = 60;

const ATTENTION_PRIORITY: Record<SwarmAttentionKind, number> = {
	decision: 0,
	failure: 1,
	review: 2,
	stuck: 3,
	quota: 4,
	error: 5,
	fyi: 6,
};

const VALID_ATTENTION_KINDS = new Set<SwarmAttentionKind>([
	"decision",
	"failure",
	"review",
	"stuck",
	"quota",
	"error",
	"fyi",
]);
const VALID_SEVERITIES = new Set<SwarmAttentionSeverity>(["high", "med", "low"]);
const VALID_WORKSTREAM_STATES = new Set<SwarmWorkstreamState>([
	"queued",
	"active",
	"blocked",
	"review",
	"done",
	"failed",
]);

function nowIso(): string {
	return new Date().toISOString();
}

class SwarmRateLimiter {
	readonly #timestamps = new Map<string, number[]>();

	allow(agent: string, now = Date.now()): void {
		const cutoff = now - 60_000;
		const existing = (this.#timestamps.get(agent) ?? []).filter(ts => ts > cutoff);
		if (existing.length >= RATE_LIMIT_PER_MINUTE) {
			throw new Error(`rate limit exceeded (limit ${RATE_LIMIT_PER_MINUTE} posts a minute)`);
		}
		existing.push(now);
		this.#timestamps.set(agent, existing);
	}
}

export interface ReadViewOptions {
	memberName: string;
	since?: number;
	limit?: number;
	seqs?: readonly number[];
	channel?: string;
	advanceCursor?: boolean;
}

export interface ReadViewResult {
	head: number;
	messages: SwarmBoardMessage[];
	channelLabel: string;
	lastReadSeq: number;
}

/**
 * Durable file-backed Swarm Board Store (`board.jsonl` + `members.json` + `view.json`),
 * matching Antigravity v1.5.5 `native_swarm/board/filestore`.
 */
export class SwarmBoardStore {
	static readonly #instances = new Map<string, SwarmBoardStore>();

	static forDir(swarmDir: string): SwarmBoardStore {
		const resolved = path.resolve(swarmDir);
		let store = SwarmBoardStore.#instances.get(resolved);
		if (!store) {
			store = new SwarmBoardStore(resolved);
			SwarmBoardStore.#instances.set(resolved, store);
		}
		return store;
	}

	static resetForTests(): void {
		SwarmBoardStore.#instances.clear();
	}

	readonly dir: string;
	#lockChain: Promise<void> = Promise.resolve();
	readonly #rateLimiter = new SwarmRateLimiter();
	#lastGoodOverview: SwarmOverviewView | null = null;

	constructor(dir: string) {
		this.dir = dir;
	}

	async #withLock<T>(fn: () => Promise<T>): Promise<T> {
		const prev = this.#lockChain;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#lockChain = promise;
		await prev;
		try {
			return await fn();
		} finally {
			resolve();
		}
	}

	get boardPath(): string {
		return path.join(this.dir, BOARD_FILE);
	}

	get membersPath(): string {
		return path.join(this.dir, MEMBERS_FILE);
	}

	get viewJsonPath(): string {
		return path.join(this.dir, VIEW_JSON_FILE);
	}

	async exists(): Promise<boolean> {
		try {
			await fs.stat(this.membersPath);
			return true;
		} catch (err) {
			if (isEnoent(err)) return false;
			throw err;
		}
	}

	async #readRosterUnlocked(): Promise<SwarmRosterFile | null> {
		try {
			const parsed = (await Bun.file(this.membersPath).json()) as SwarmRosterFile;
			if (!isRecord(parsed) || !isRecord(parsed.members)) return null;
			if (!Array.isArray(parsed.channels)) parsed.channels = [];
			return parsed;
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}
	}

	async #writeRosterUnlocked(roster: SwarmRosterFile): Promise<void> {
		await fs.mkdir(this.dir, { recursive: true });
		const tmpPath = `${this.membersPath}.tmp.${Snowflake.next()}`;
		await Bun.write(tmpPath, `${JSON.stringify(roster, null, 2)}\n`);
		await fs.rename(tmpPath, this.membersPath);
	}

	async #readMessagesUnlocked(): Promise<SwarmBoardMessage[]> {
		let text: string;
		try {
			text = await Bun.file(this.boardPath).text();
		} catch (err) {
			if (isEnoent(err)) return [];
			throw err;
		}
		if (!text.trim()) return [];
		const out: SwarmBoardMessage[] = [];
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const parsed = JSON.parse(trimmed) as SwarmBoardMessage;
				if (typeof parsed.seq === "number" && typeof parsed.agent === "string" && typeof parsed.text === "string") {
					out.push(parsed);
				}
			} catch {
				// Ignore truncated tail line if caught mid-crash
			}
		}
		return out;
	}

	async #appendMessageUnlocked(
		msg: Omit<SwarmBoardMessage, "seq" | "time"> & { seq: number; time?: string },
	): Promise<SwarmBoardMessage> {
		await fs.mkdir(this.dir, { recursive: true });
		const full: SwarmBoardMessage = {
			seq: msg.seq,
			agent: msg.agent,
			text: msg.text,
			time: msg.time ?? nowIso(),
			...(msg.kind ? { kind: msg.kind } : {}),
			...(msg.channel && msg.channel !== SWARM_MAIN_CHANNEL ? { channel: msg.channel } : {}),
			...(msg.control ? { control: msg.control } : {}),
		};
		await fs.appendFile(this.boardPath, `${JSON.stringify(full)}\n`, "utf8");
		return full;
	}

	/** Ensure the swarm exists on disk with a `coordinator` member row. */
	async ensureSwarm(params: {
		coordinatorAgentId: string;
		coordinatorConversationId: string;
		model: string;
		title?: string;
	}): Promise<SwarmRosterFile> {
		return this.#withLock(async () => {
			let roster = await this.#readRosterUnlocked();
			const now = nowIso();
			if (!roster) {
				roster = {
					swarm_id: `swarm-${Snowflake.next()}`,
					title: params.title?.trim() ?? "",
					created_at: now,
					channels: [],
					members: {
						coordinator: {
							name: "coordinator",
							agent_id: params.coordinatorAgentId,
							conversation_id: params.coordinatorConversationId,
							role: "coordinator",
							added_by: "coordinator",
							model: params.model,
							workspace: "inherit",
							channels: null,
							wake_mode: "mentions",
							wait_since: 0,
							last_read_seq: 0,
							killed: false,
							updated_at: now,
						},
					},
				};
				await fs.mkdir(this.dir, { recursive: true });
				try {
					await fs.stat(this.boardPath);
				} catch (err) {
					if (isEnoent(err)) await Bun.write(this.boardPath, "");
				}
				await this.#writeRosterUnlocked(roster);
				return roster;
			}
			const coord = roster.members.coordinator;
			let dirty = false;
			if (coord) {
				if (params.coordinatorAgentId && coord.agent_id !== params.coordinatorAgentId) {
					coord.agent_id = params.coordinatorAgentId;
					dirty = true;
				}
				if (params.model && coord.model !== params.model) {
					coord.model = params.model;
					dirty = true;
				}
			}
			if (params.title !== undefined && params.title.trim() && roster.title !== params.title.trim()) {
				roster.title = params.title.trim();
				dirty = true;
			}
			if (dirty) {
				await this.#writeRosterUnlocked(roster);
			}
			return roster;
		});
	}

	async getSnapshot(): Promise<{ roster: SwarmRosterFile | null; messages: SwarmBoardMessage[]; head: number }> {
		return this.#withLock(async () => {
			const roster = await this.#readRosterUnlocked();
			const messages = await this.#readMessagesUnlocked();
			const head = messages.length > 0 ? messages[messages.length - 1]!.seq : 0;
			return { roster, messages, head };
		});
	}

	async setTitle(actor: string, title: string): Promise<SwarmRosterFile> {
		const trimmed = title.trim();
		if (!trimmed) throw new Error("title is required");
		return this.#withLock(async () => {
			const roster = await this.#readRosterUnlocked();
			if (!roster) throw new Error("no swarm yet; the coordinator creates it");
			if (actor !== "coordinator") {
				throw new Error(`"${actor}" is not the coordinator`);
			}
			roster.title = trimmed;
			await this.#writeRosterUnlocked(roster);
			return roster;
		});
	}

	/** Post a user/agent message to the board, validating channel & `@#channel` rules and advancing contiguous author cursor. */
	async postMessage(params: {
		author: string;
		text: string;
		channel?: string;
		kind?: "post" | "brief";
		skipRateLimit?: boolean;
	}): Promise<{ message: SwarmBoardMessage; warnings: string[]; roster: SwarmRosterFile }> {
		const trimmed = params.text.trim();
		if (!trimmed) throw new Error("text is required");
		const byteLen = Buffer.byteLength(trimmed, "utf8");
		if (byteLen > MAX_POST_BYTES) {
			throw new Error(`post too large (${byteLen} bytes, limit ${MAX_POST_BYTES})`);
		}

		return this.#withLock(async () => {
			const roster = await this.#readRosterUnlocked();
			if (!roster) throw new Error("no swarm yet; add a worker to start one");
			const member = roster.members[params.author];
			if (!member) {
				throw new Error(`this conversation ("${params.author}") is not a member of the swarm`);
			}
			if (member.killed) {
				throw new Error(`"${params.author}" was killed and cannot post to the board`);
			}
			if (effectiveRole(member.name, member.role) === "narrator") {
				throw new Error("the narrator never posts to the board; write view.json instead");
			}
			if (!params.skipRateLimit) {
				this.#rateLimiter.allow(params.author);
			}

			const channelMap = new Map<string, SwarmChannelInfo>(roster.channels.map(c => [c.name, c]));
			const isActiveChannel = (ch: string) => {
				const info = channelMap.get(ch);
				return Boolean(info && !info.archived);
			};

			let targetChannel: string;
			if (params.channel !== undefined && params.channel.trim() !== "") {
				targetChannel = normalizeChannelSelector(params.channel);
				if (targetChannel === SWARM_ALL_CHANNELS) {
					throw new Error('cannot post to "*"; choose a specific channel or "main"');
				}
				if (targetChannel !== SWARM_MAIN_CHANNEL && !isActiveChannel(targetChannel)) {
					const activeList = ["#main", ...roster.channels.filter(c => !c.archived).map(c => `#${c.name}`)].join(
						", ",
					);
					throw new Error(`inactive or unknown channel #${targetChannel} (active channels: ${activeList})`);
				}
			} else {
				targetChannel = homeChannelIn(member.channels, isActiveChannel);
			}

			const warnings = checkChannelMentions(trimmed, ch => {
				const info = channelMap.get(ch);
				return { exists: Boolean(info), archived: Boolean(info?.archived) };
			});

			const messages = await this.#readMessagesUnlocked();
			const prevHead = messages.length > 0 ? messages[messages.length - 1]!.seq : 0;
			const nextSeq = prevHead + 1;
			const appended = await this.#appendMessageUnlocked({
				seq: nextSeq,
				agent: params.author,
				text: trimmed,
				kind: params.kind ?? "post",
				channel: targetChannel,
			});

			// FastForwardAuthor: if author had already read everything up to prevHead, advance last_read_seq to nextSeq.
			if (member.last_read_seq >= prevHead) {
				member.last_read_seq = nextSeq;
			}
			member.last_post_seq = nextSeq;
			member.last_post_time = appended.time;
			member.updated_at = appended.time;
			await this.#writeRosterUnlocked(roster);

			return { message: appended, warnings, roster };
		});
	}

	/** Add newly spawned worker rows and record their public brief on `board.jsonl`. */
	async addMembersWithBrief(params: {
		actor: string;
		briefText: string;
		briefChannel: string;
		newMembers: Array<Omit<SwarmMemberRecord, "last_read_seq" | "wait_since" | "updated_at">>;
	}): Promise<{ briefMessage: SwarmBoardMessage; roster: SwarmRosterFile }> {
		return this.#withLock(async () => {
			const roster = await this.#readRosterUnlocked();
			if (!roster) throw new Error("no swarm yet; only the coordinator can start one");
			const actorRow = roster.members[params.actor];
			if (!actorRow) throw new Error(`this conversation ("${params.actor}") is not a member of the swarm`);
			if (actorRow.killed) throw new Error(`you were killed and cannot add workers`);

			for (const candidate of params.newMembers) {
				if (Object.hasOwn(roster.members, candidate.name)) {
					throw new Error(`the swarm already has a member named "${candidate.name}"`);
				}
			}

			const channelMap = new Map<string, SwarmChannelInfo>(roster.channels.map(c => [c.name, c]));
			const targetChannel =
				params.briefChannel && params.briefChannel !== SWARM_MAIN_CHANNEL
					? validateChannelName(params.briefChannel)
					: SWARM_MAIN_CHANNEL;
			if (targetChannel !== SWARM_MAIN_CHANNEL) {
				const chInfo = channelMap.get(targetChannel);
				if (!chInfo || chInfo.archived) {
					throw new Error(`channel #${targetChannel} does not exist or is archived`);
				}
			}

			const messages = await this.#readMessagesUnlocked();
			const prevHead = messages.length > 0 ? messages[messages.length - 1]!.seq : 0;
			const briefSeq = prevHead + 1;
			const now = nowIso();

			const briefMessage = await this.#appendMessageUnlocked({
				seq: briefSeq,
				agent: params.actor,
				text: params.briefText,
				kind: "brief",
				channel: targetChannel,
				time: now,
			});

			if (actorRow.last_read_seq >= prevHead) {
				actorRow.last_read_seq = briefSeq;
			}
			actorRow.last_post_seq = briefSeq;
			actorRow.last_post_time = now;
			actorRow.updated_at = now;

			// Each new worker receives its brief directly in its first message with its cursor set past the startup brief.
			for (const m of params.newMembers) {
				roster.members[m.name] = {
					...m,
					wait_since: briefSeq,
					last_read_seq: briefSeq,
					updated_at: now,
				};
			}

			await this.#writeRosterUnlocked(roster);
			return { briefMessage, roster };
		});
	}

	/** Read messages from the board according to member channel visibility, advancing `last_read_seq` on chronological reads. */
	async readView(options: ReadViewOptions): Promise<ReadViewResult> {
		return this.#withLock(async () => {
			const roster = await this.#readRosterUnlocked();
			if (!roster) {
				return { head: 0, messages: [], channelLabel: "#main", lastReadSeq: 0 };
			}
			const member = roster.members[options.memberName];
			const messages = await this.#readMessagesUnlocked();
			const head = messages.length > 0 ? messages[messages.length - 1]!.seq : 0;
			const channelMap = new Map<string, SwarmChannelInfo>(roster.channels.map(c => [c.name, c]));
			const isActiveChannel = (ch: string) => {
				const info = channelMap.get(ch);
				return Boolean(info && !info.archived);
			};
			const memberSet = member ? effectiveChannels(member.role, member.channels, member.name) : [SWARM_ALL_CHANNELS];

			// Exact `#seq` lookup (`seqs: [...]`) ignores `since`, `limit`, and `channel` and does not jump `last_read_seq`.
			if (options.seqs && options.seqs.length > 0) {
				const wanted = new Set(options.seqs.filter(n => Number.isInteger(n) && n > 0));
				const selected = messages.filter(
					msg => wanted.has(msg.seq) && seesIn(options.memberName, memberSet, msg, isActiveChannel),
				);
				return {
					head,
					messages: selected,
					channelLabel: "selected seqs",
					lastReadSeq: member?.last_read_seq ?? head,
				};
			}

			let channelLabel = "your channels";
			let filterFn: (msg: SwarmBoardMessage) => boolean;
			if (options.channel !== undefined && options.channel.trim() !== "") {
				const sel = normalizeChannelSelector(options.channel);
				if (sel === SWARM_ALL_CHANNELS) {
					channelLabel = "all channels";
					filterFn = () => true;
				} else {
					if (sel !== SWARM_MAIN_CHANNEL && !channelMap.has(sel)) {
						const known = ["#main", ...roster.channels.map(c => `#${c.name}`)].join(", ");
						throw new Error(`unknown channel #${sel} (channels: ${known})`);
					}
					channelLabel = `#${sel}`;
					filterFn = msg => messageChannelOf(msg) === sel;
				}
			} else {
				filterFn = msg => seesIn(options.memberName, memberSet, msg, isActiveChannel);
			}

			const visible = messages.filter(filterFn);
			const limit = Math.max(1, Math.min(options.limit ?? 20, 500));
			let sliced: SwarmBoardMessage[];
			if (options.since !== undefined) {
				const afterSince = visible.filter(msg => msg.seq > options.since!);
				sliced = afterSince.slice(0, limit);
			} else {
				sliced = visible.slice(-limit);
			}

			let lastReadSeq = member?.last_read_seq ?? 0;
			if (member && options.advanceCursor !== false) {
				if (sliced.length > 0) {
					const highestReturned = sliced[sliced.length - 1]!.seq;
					// Advance when reading from <= current last_read_seq or initial tail read
					if (options.since === undefined || options.since <= member.last_read_seq) {
						const caughtUp =
							options.since !== undefined &&
							visible.filter(msg => msg.seq > options.since!).length <= sliced.length &&
							options.channel === undefined;
						lastReadSeq = Math.max(member.last_read_seq, caughtUp ? head : highestReturned);
					} else {
						lastReadSeq = Math.max(member.last_read_seq, highestReturned);
					}
				} else if (options.since !== undefined && options.since <= head && options.channel === undefined) {
					lastReadSeq = Math.max(member.last_read_seq, head);
				}
				if (lastReadSeq !== member.last_read_seq) {
					member.last_read_seq = lastReadSeq;
					member.updated_at = nowIso();
					await this.#writeRosterUnlocked(roster);
				}
			}

			return { head, messages: sliced, channelLabel, lastReadSeq };
		});
	}

	/** Update a member's wait cursor/mode (`wake.Park`). */
	async recordWait(memberName: string, since: number, wakeMode: SwarmWakeMode): Promise<void> {
		await this.#withLock(async () => {
			const roster = await this.#readRosterUnlocked();
			const member = roster?.members[memberName];
			if (!roster || !member) return;
			member.wake_mode = wakeMode;
			member.wait_since = Math.max(0, Math.floor(since));
			member.last_read_seq = Math.max(member.last_read_seq, member.wait_since);
			member.updated_at = nowIso();
			await this.#writeRosterUnlocked(roster);
		});
	}

	/** Mark one or more members permanently `killed` on the roster. */
	async markKilled(names: readonly string[]): Promise<SwarmRosterFile | null> {
		return this.#withLock(async () => {
			const roster = await this.#readRosterUnlocked();
			if (!roster) return null;
			const now = nowIso();
			for (const name of names) {
				const row = roster.members[name];
				if (row) {
					row.killed = true;
					row.updated_at = now;
				}
			}
			await this.#writeRosterUnlocked(roster);
			return roster;
		});
	}

	/** Update a member's active model or error metadata on the roster. */
	async updateMemberFields(
		memberName: string,
		patch: Partial<
			Pick<SwarmMemberRecord, "model" | "last_error" | "quota_exhausted" | "workspace_note" | "agent_id">
		>,
	): Promise<SwarmMemberRecord | null> {
		return this.#withLock(async () => {
			const roster = await this.#readRosterUnlocked();
			const row = roster?.members[memberName];
			if (!roster || !row) return null;
			Object.assign(row, patch, { updated_at: nowIso() });
			await this.#writeRosterUnlocked(roster);
			return row;
		});
	}

	/** Execute channel management ops (`create`, `archive`, `subscribe`, `unsubscribe`, `list`). */
	async executeChannelOp(params: {
		actor: string;
		op: "create" | "archive" | "subscribe" | "unsubscribe" | "list";
		channel?: string;
		topic?: string;
		targetMember?: string;
	}): Promise<{ text: string; roster: SwarmRosterFile; message?: SwarmBoardMessage }> {
		return this.#withLock(async () => {
			const roster = await this.#readRosterUnlocked();
			if (!roster) throw new Error("no swarm yet; add a worker to start one");
			const actorRow = roster.members[params.actor];
			if (!actorRow || actorRow.killed) {
				throw new Error(`this conversation ("${params.actor}") is not a live member of the swarm`);
			}

			if (params.op === "list") {
				const lines = [
					"| channel | topic | created by | members |",
					"|---|---|---|---|",
					"| #main | everyone | — | all |",
				];
				for (const ch of roster.channels) {
					const count = Object.values(roster.members).filter(
						m => !m.killed && m.channels?.includes(ch.name),
					).length;
					const label = ch.archived ? `#${ch.name} (archived)` : `#${ch.name}`;
					lines.push(`| ${label} | ${ch.topic || "—"} | @${ch.created_by} | ${count} |`);
				}
				lines.push(
					"",
					"Everyone is always in main. members counts the members subscribed by name; the coordinator, narrator and monitor see every channel.",
				);
				return { text: lines.join("\n"), roster };
			}

			if (!params.channel?.trim()) {
				throw new Error(`channel is required for op "${params.op}"`);
			}
			const chName = validateChannelName(params.channel);
			const messages = await this.#readMessagesUnlocked();
			const nextSeq = (messages.length > 0 ? messages[messages.length - 1]!.seq : 0) + 1;

			if (params.op === "create") {
				const existing = roster.channels.find(c => c.name === chName);
				if (existing) {
					throw new Error(`channel #${chName} already exists (created by "${existing.created_by}")`);
				}
				const topic = (params.topic ?? "").trim();
				if (Buffer.byteLength(topic, "utf8") > MAX_CHANNEL_TOPIC_BYTES) {
					throw new Error(`topic is longer than ${MAX_CHANNEL_TOPIC_BYTES} bytes`);
				}
				if (topic.includes("@") || /[\r\n]/.test(topic)) {
					throw new Error("a topic may not contain '@' or line breaks");
				}
				roster.channels.push({
					name: chName,
					topic,
					created_by: params.actor,
					archived: false,
				});
				const controlMsg = await this.#appendMessageUnlocked({
					seq: nextSeq,
					agent: params.actor,
					text: `[channel] @${params.actor} created #${chName}${topic ? `: ${topic}` : ""}`,
					kind: "control",
					control: { op: "create", channel: chName, topic: topic || undefined, actor: params.actor },
				});
				await this.#writeRosterUnlocked(roster);
				return {
					text: `Created #${chName}. Put workers in it with add{channels:["${chName}"]} or op:"subscribe", and post its work there with post_message{channel:"${chName}"}.`,
					roster,
					message: controlMsg,
				};
			}

			const chInfo = roster.channels.find(c => c.name === chName);
			if (!chInfo) {
				throw new Error(`unknown channel #${chName}`);
			}

			if (params.op === "archive") {
				if (params.actor !== "coordinator" && chInfo.created_by !== params.actor) {
					throw new Error(
						`#${chName} was created by "${chInfo.created_by}"; only its creator or coordinator can archive it`,
					);
				}
				if (chInfo.archived) {
					return { text: "Nothing to change.", roster };
				}
				chInfo.archived = true;
				const controlMsg = await this.#appendMessageUnlocked({
					seq: nextSeq,
					agent: params.actor,
					text: `[channel] @${params.actor} archived #${chName}`,
					kind: "control",
					control: { op: "archive", channel: chName, actor: params.actor },
				});
				await this.#writeRosterUnlocked(roster);
				return {
					text: `Archived #${chName}: no more posts there; its history stays readable with read_board{channel:"${chName}"}.`,
					roster,
					message: controlMsg,
				};
			}

			// subscribe / unsubscribe
			const targetName = params.targetMember?.trim() || params.actor;
			const targetRow = roster.members[targetName];
			if (!targetRow || targetRow.killed) {
				throw new Error(`no live swarm member named "${targetName}"`);
			}
			if (params.actor !== "coordinator" && targetName !== params.actor && targetRow.added_by !== params.actor) {
				throw new Error(
					`you may ${params.op} only yourself or the workers you added, not @${targetName}; ask @coordinator on the board`,
				);
			}
			const effSet = effectiveChannels(targetRow.role, targetRow.channels, targetRow.name);
			if (effSet.includes(SWARM_ALL_CHANNELS)) {
				throw new Error(
					`"${targetName}" sees every channel (*) by role (${effectiveRole(targetRow.name, targetRow.role)}); channel subscriptions do not apply`,
				);
			}
			if (params.op === "subscribe" && chInfo.archived) {
				throw new Error(`cannot subscribe to archived channel #${chName}`);
			}

			const prevSet = targetRow.channels ? [...targetRow.channels] : null;
			const currentList = targetRow.channels ? [...targetRow.channels] : [];
			if (params.op === "subscribe") {
				if (currentList.includes(chName)) {
					return { text: "Nothing to change.", roster };
				}
				currentList.push(chName);
			} else {
				if (!currentList.includes(chName)) {
					return { text: "Nothing to change.", roster };
				}
				const idx = currentList.indexOf(chName);
				currentList.splice(idx, 1);
			}
			targetRow.channels = currentList.length > 0 ? currentList : null;
			targetRow.updated_at = nowIso();

			const verb = params.op === "subscribe" ? "subscribed to" : "unsubscribed from";
			const bySuffix = params.actor !== targetName ? ` (by @${params.actor})` : "";
			const controlMsg = await this.#appendMessageUnlocked({
				seq: nextSeq,
				agent: params.actor,
				text: `[channel] @${targetName} ${verb} #${chName}${bySuffix}`,
				kind: "control",
				control: {
					op: params.op,
					channel: chName,
					actor: params.actor,
					members: [targetName],
					prev: { [targetName]: prevSet },
					next: { [targetName]: targetRow.channels },
				},
			});
			await this.#writeRosterUnlocked(roster);

			const isSelf = targetName === params.actor;
			const text =
				params.op === "subscribe"
					? `${isSelf ? "You now see" : `@${targetName} now sees`} #${chName}'s posts from here on, but not earlier ones: read_board{channel:"${chName}"} reads its history.`
					: `${isSelf ? "You no longer see" : `@${targetName} no longer sees`} #${chName}'s posts, except those that name ${isSelf ? "you" : "it"}.`;
			return { text, roster, message: controlMsg };
		});
	}

	/**
	 * Read and sanitize `SWARM_DIR/view.json` written by `swarm-narrator` (64 KB cap,
	 * last-good-parse fallback, ref verification, and attention priority ranking).
	 */
	async readNarratorOverview(head: number, rosterNames: ReadonlySet<string>): Promise<SwarmOverviewView | null> {
		let rawText: string;
		try {
			const file = Bun.file(this.viewJsonPath);
			const stat = await file.stat();
			if (stat.size === 0 || stat.size > VIEW_MAX_BYTES) {
				return this.#lastGoodOverview ? { ...this.#lastGoodOverview, stale_fallback: true } : null;
			}
			rawText = await file.text();
		} catch (err) {
			if (isEnoent(err)) {
				this.#lastGoodOverview = null;
				return null;
			}
			return this.#lastGoodOverview ? { ...this.#lastGoodOverview, stale_fallback: true } : null;
		}

		try {
			const raw = JSON.parse(rawText);
			if (!isRecord(raw)) {
				return this.#lastGoodOverview ? { ...this.#lastGoodOverview, stale_fallback: true } : null;
			}
			const sanitizeRefs = (refsRaw: unknown): SwarmRef[] => {
				if (!Array.isArray(refsRaw)) return [];
				const refs: SwarmRef[] = [];
				for (const r of refsRaw) {
					if (!isRecord(r)) continue;
					const seq = typeof r.seq === "number" && Number.isInteger(r.seq) && r.seq > 0 ? r.seq : undefined;
					const member = typeof r.member === "string" && r.member ? r.member : undefined;
					if (seq === undefined && member === undefined) continue;
					const unverified =
						(seq !== undefined && seq > head) || (member !== undefined && !rosterNames.has(member));
					refs.push({
						...(seq !== undefined ? { seq } : {}),
						...(member ? { member } : {}),
						...(unverified ? { unverified: true } : {}),
					});
				}
				return refs;
			};

			const attention: SwarmAttentionItem[] = [];
			if (Array.isArray(raw.attention)) {
				for (const item of raw.attention) {
					if (!isRecord(item) || typeof item.id !== "string" || typeof item.title !== "string") continue;
					const kind: SwarmAttentionKind = VALID_ATTENTION_KINDS.has(item.kind as SwarmAttentionKind)
						? (item.kind as SwarmAttentionKind)
						: "fyi";
					const severity: SwarmAttentionSeverity = VALID_SEVERITIES.has(item.severity as SwarmAttentionSeverity)
						? (item.severity as SwarmAttentionSeverity)
						: "med";
					const refs = sanitizeRefs(item.refs);
					attention.push({
						id: item.id.slice(0, 40),
						kind,
						severity,
						title: item.title.slice(0, 200),
						...(typeof item.why === "string" ? { why: item.why.slice(0, 240) } : {}),
						...(isRecord(item.short) &&
						typeof item.short.title === "string" &&
						typeof item.short.line === "string"
							? { short: { title: item.short.title.slice(0, 80), line: item.short.line.slice(0, 140) } }
							: {}),
						refs,
						...(refs.length === 0 ? { uncited: true } : {}),
					});
				}
			}
			attention.sort((a, b) => ATTENTION_PRIORITY[a.kind] - ATTENTION_PRIORITY[b.kind]);

			const workstreams: SwarmWorkstreamItem[] = [];
			if (Array.isArray(raw.workstreams)) {
				for (const ws of raw.workstreams) {
					if (!isRecord(ws) || typeof ws.id !== "string" || typeof ws.title !== "string") continue;
					const state: SwarmWorkstreamState = VALID_WORKSTREAM_STATES.has(ws.state as SwarmWorkstreamState)
						? (ws.state as SwarmWorkstreamState)
						: "active";
					const owners = Array.isArray(ws.owners)
						? ws.owners.filter((o): o is string => typeof o === "string" && o.length > 0)
						: [];
					const refs = sanitizeRefs(ws.refs);
					workstreams.push({
						id: ws.id.slice(0, 40),
						title: ws.title.slice(0, 200),
						owners,
						state,
						...(typeof ws.note === "string" ? { note: ws.note.slice(0, 200) } : {}),
						...(isRecord(ws.short) && typeof ws.short.title === "string" && typeof ws.short.line === "string"
							? { short: { title: ws.short.title.slice(0, 80), line: ws.short.line.slice(0, 140) } }
							: {}),
						...(isRecord(ws.progress) &&
						typeof ws.progress.done === "number" &&
						typeof ws.progress.total === "number"
							? { progress: { done: ws.progress.done, total: ws.progress.total } }
							: {}),
						refs,
						...(refs.length === 0 ? { uncited: true } : {}),
					});
				}
			}

			const parseNotes = (arr: unknown): SwarmNoteItem[] => {
				if (!Array.isArray(arr)) return [];
				const notes: SwarmNoteItem[] = [];
				for (const n of arr) {
					if (!isRecord(n) || typeof n.id !== "string" || typeof n.text !== "string") continue;
					notes.push({ id: n.id.slice(0, 40), text: n.text.slice(0, 200), refs: sanitizeRefs(n.refs) });
				}
				return notes;
			};

			const view: SwarmOverviewView = {
				version: typeof raw.version === "number" ? raw.version : 1,
				as_of_seq: typeof raw.as_of_seq === "number" ? raw.as_of_seq : 0,
				updated_at: typeof raw.updated_at === "string" ? raw.updated_at : nowIso(),
				headline: typeof raw.headline === "string" ? raw.headline.slice(0, 240) : "",
				...(isRecord(raw.goal) && typeof raw.goal.title === "string" && typeof raw.goal.line === "string"
					? { goal: { title: raw.goal.title.slice(0, 120), line: raw.goal.line.slice(0, 160) } }
					: {}),
				...(typeof raw.running_summary === "string" ? { running_summary: raw.running_summary.slice(0, 240) } : {}),
				...(isRecord(raw.phase) &&
				typeof raw.phase.label === "string" &&
				typeof raw.phase.index === "number" &&
				typeof raw.phase.total === "number"
					? { phase: { label: raw.phase.label.slice(0, 60), index: raw.phase.index, total: raw.phase.total } }
					: {}),
				...(Array.isArray(raw.threads)
					? {
							threads: raw.threads
								.filter(
									(t): t is Record<string, unknown> =>
										isRecord(t) && typeof t.id === "string" && typeof t.title === "string",
								)
								.slice(0, 8)
								.map(t => ({
									id: String(t.id).slice(0, 40),
									title: String(t.title).slice(0, 100),
									...(typeof t.goal === "string" ? { goal: t.goal.slice(0, 140) } : {}),
									...(typeof t.now === "string" ? { now: t.now.slice(0, 140) } : {}),
									workstreams: Array.isArray(t.workstreams)
										? t.workstreams.filter((x): x is string => typeof x === "string")
										: [],
									attention: Array.isArray(t.attention)
										? t.attention.filter((x): x is string => typeof x === "string")
										: [],
								})),
						}
					: {}),
				attention,
				workstreams,
				milestones: parseNotes(raw.milestones),
				risks: parseNotes(raw.risks),
				...(isRecord(raw.now)
					? {
							now: Object.fromEntries(
								Object.entries(raw.now)
									.filter(([, v]) => typeof v === "string")
									.map(([k, v]) => [k, String(v).slice(0, 80)]),
							),
						}
					: {}),
				...(isRecord(raw.feedback_ack) &&
				typeof raw.feedback_ack.through_seq === "number" &&
				typeof raw.feedback_ack.text === "string"
					? {
							feedback_ack: {
								through_seq: raw.feedback_ack.through_seq,
								text: raw.feedback_ack.text.slice(0, 200),
							},
						}
					: {}),
			};
			this.#lastGoodOverview = view;
			return view;
		} catch {
			return this.#lastGoodOverview ? { ...this.#lastGoodOverview, stale_fallback: true } : null;
		}
	}
}

export { countsAsUnread };
