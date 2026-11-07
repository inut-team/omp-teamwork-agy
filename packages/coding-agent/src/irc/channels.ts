/**
 * Scoped pub/sub topic channels for `agent://channel/<topic>` coordination
 * (Google Antigravity v1.5.0 `native_swarm` channel_action / board parity).
 *
 * State lives in `<artifactsDir>/_channels/<topic>.json` when the session has
 * an artifacts directory (shared across main thread, subagent worker threads,
 * and resumed sessions) and falls back to an in-memory map for ephemeral
 * sessions and unit tests. Delivery reuses `IrcBus.global().send(...)` so
 * worker-thread proxies (`RemoteIrcBus`), idle wakes, running step-boundary
 * asides, and parked revivals all work without duplicating transport logic.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { IrcDeliveryReceipt } from "@oh-my-pi/pi-tui/tools/irc";
import type { CoordinationDetails } from "@oh-my-pi/pi-tui/tools/wait";
import { isEnoent, Snowflake } from "@oh-my-pi/pi-utils";
import type { AgentRegistryApi } from "../registry/agent-registry";
import { ensurePersistedRoster } from "../registry/persisted-agents";
import { IrcBus } from "./bus";

const CHANNEL_TOPIC_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CHANNEL_HISTORY_CAP = 200;
const CHANNELS_SUBDIR = "_channels";

export interface ChannelPost {
	id: string;
	channel: string;
	from: string;
	body: string;
	ts: number;
}

export interface ChannelState {
	channel: string;
	subscribers: string[];
	posts: ChannelPost[];
}

export interface ChannelSummary {
	channel: string;
	subscribers: string[];
	messageCount: number;
	lastPostAt?: number;
}

/** Validate and normalize a channel topic (strips optional leading `#`, lowercases). */
export function normalizeChannelTopic(raw: string): string {
	let cleaned = raw.trim();
	try {
		cleaned = decodeURIComponent(cleaned).trim();
	} catch {
		// Keep raw input if percent-decoding fails; regex below validates it.
	}
	if (cleaned.startsWith("#")) cleaned = cleaned.slice(1).trim();
	if (!cleaned) {
		throw new Error(
			"Channel topic cannot be empty. Use letters, digits, '.', '_', or '-' (e.g. agent://channel/api-contract).",
		);
	}
	if (!CHANNEL_TOPIC_PATTERN.test(cleaned)) {
		throw new Error(
			`Invalid channel topic "${cleaned}". Channel names must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.`,
		);
	}
	return cleaned.toLowerCase();
}

function channelFilePath(artifactsDir: string, normalizedTopic: string): string {
	return path.join(artifactsDir, CHANNELS_SUBDIR, `${normalizedTopic}.json`);
}

async function readDiskChannel(artifactsDir: string, normalizedTopic: string): Promise<ChannelState | null> {
	try {
		const raw = (await Bun.file(channelFilePath(artifactsDir, normalizedTopic)).json()) as Partial<ChannelState>;
		if (!raw || typeof raw !== "object") return null;
		return {
			channel: typeof raw.channel === "string" ? raw.channel : normalizedTopic,
			subscribers: Array.isArray(raw.subscribers)
				? [...new Set(raw.subscribers.filter((id): id is string => typeof id === "string" && id.length > 0))]
				: [],
			posts: Array.isArray(raw.posts) ? (raw.posts as ChannelPost[]) : [],
		};
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

async function writeDiskChannel(artifactsDir: string, state: ChannelState): Promise<void> {
	const targetPath = channelFilePath(artifactsDir, state.channel);
	const tmpPath = `${targetPath}.${Snowflake.next()}.tmp`;
	await Bun.write(tmpPath, JSON.stringify(state, null, 2));
	await fs.rename(tmpPath, targetPath);
}

export class ChannelBoard {
	static #global: ChannelBoard | undefined;

	static global(): ChannelBoard {
		if (!ChannelBoard.#global) {
			ChannelBoard.#global = new ChannelBoard();
		}
		return ChannelBoard.#global;
	}

	static resetGlobalForTests(): void {
		ChannelBoard.#global = undefined;
	}

	readonly #memory = new Map<string, ChannelState>();

	#getOrCreateMemory(topic: string): ChannelState {
		let state = this.#memory.get(topic);
		if (!state) {
			state = { channel: topic, subscribers: [], posts: [] };
			this.#memory.set(topic, state);
		}
		return state;
	}

	async subscribe(rawTopic: string, agentId: string, artifactsDir?: string | null): Promise<ChannelState> {
		const topic = normalizeChannelTopic(rawTopic);
		if (artifactsDir) {
			const existing = (await readDiskChannel(artifactsDir, topic)) ?? {
				channel: topic,
				subscribers: [],
				posts: [],
			};
			if (!existing.subscribers.includes(agentId)) {
				existing.subscribers.push(agentId);
				await writeDiskChannel(artifactsDir, existing);
			}
			return existing;
		}
		const state = this.#getOrCreateMemory(topic);
		if (!state.subscribers.includes(agentId)) {
			state.subscribers.push(agentId);
		}
		return {
			channel: state.channel,
			subscribers: [...state.subscribers],
			posts: [...state.posts],
		};
	}

	async subscribeMany(rawTopics: readonly string[], agentId: string, artifactsDir?: string | null): Promise<string[]> {
		const normalized: string[] = [];
		for (const raw of rawTopics) {
			const state = await this.subscribe(raw, agentId, artifactsDir);
			if (!normalized.includes(state.channel)) normalized.push(state.channel);
		}
		return normalized;
	}

	async unsubscribe(rawTopic: string, agentId: string, artifactsDir?: string | null): Promise<ChannelState> {
		const topic = normalizeChannelTopic(rawTopic);
		if (artifactsDir) {
			const existing = (await readDiskChannel(artifactsDir, topic)) ?? {
				channel: topic,
				subscribers: [],
				posts: [],
			};
			const next = existing.subscribers.filter(id => id !== agentId);
			if (next.length !== existing.subscribers.length) {
				existing.subscribers = next;
				await writeDiskChannel(artifactsDir, existing);
			}
			return existing;
		}
		const state = this.#getOrCreateMemory(topic);
		state.subscribers = state.subscribers.filter(id => id !== agentId);
		return {
			channel: state.channel,
			subscribers: [...state.subscribers],
			posts: [...state.posts],
		};
	}

	async readFeed(rawTopic: string, artifactsDirs: readonly string[] = []): Promise<ChannelState> {
		const topic = normalizeChannelTopic(rawTopic);
		for (const dir of artifactsDirs) {
			const disk = await readDiskChannel(dir, topic);
			if (disk) return disk;
		}
		const mem = this.#memory.get(topic);
		if (mem) {
			return {
				channel: mem.channel,
				subscribers: [...mem.subscribers],
				posts: [...mem.posts],
			};
		}
		return { channel: topic, subscribers: [], posts: [] };
	}

	async listChannels(artifactsDirs: readonly string[] = []): Promise<ChannelSummary[]> {
		const merged = new Map<string, ChannelState>();
		for (const [topic, state] of this.#memory) {
			merged.set(topic, {
				channel: state.channel,
				subscribers: [...state.subscribers],
				posts: [...state.posts],
			});
		}
		for (const dir of artifactsDirs) {
			let entries: string[];
			try {
				entries = await fs.readdir(path.join(dir, CHANNELS_SUBDIR));
			} catch (error) {
				if (isEnoent(error)) continue;
				throw error;
			}
			for (const entry of entries) {
				if (!entry.endsWith(".json")) continue;
				const topic = entry.slice(0, -5);
				if (merged.has(topic)) continue;
				const disk = await readDiskChannel(dir, topic);
				if (disk) merged.set(topic, disk);
			}
		}
		return [...merged.values()]
			.filter(state => state.subscribers.length > 0 || state.posts.length > 0)
			.sort((a, b) => a.channel.localeCompare(b.channel))
			.map(state => ({
				channel: state.channel,
				subscribers: state.subscribers,
				messageCount: state.posts.length,
				lastPostAt: state.posts.at(-1)?.ts,
			}));
	}

	async appendPost(
		rawTopic: string,
		from: string,
		body: string,
		artifactsDir?: string | null,
	): Promise<{ state: ChannelState; post: ChannelPost }> {
		const topic = normalizeChannelTopic(rawTopic);
		const post: ChannelPost = {
			id: Snowflake.next(),
			channel: topic,
			from,
			body,
			ts: Date.now(),
		};
		if (artifactsDir) {
			const state = (await readDiskChannel(artifactsDir, topic)) ?? {
				channel: topic,
				subscribers: [],
				posts: [],
			};
			if (!state.subscribers.includes(from)) {
				state.subscribers.push(from);
			}
			state.posts.push(post);
			if (state.posts.length > CHANNEL_HISTORY_CAP) {
				state.posts.splice(0, state.posts.length - CHANNEL_HISTORY_CAP);
			}
			await writeDiskChannel(artifactsDir, state);
			return { state, post };
		}
		const state = this.#getOrCreateMemory(topic);
		if (!state.subscribers.includes(from)) {
			state.subscribers.push(from);
		}
		state.posts.push(post);
		if (state.posts.length > CHANNEL_HISTORY_CAP) {
			state.posts.splice(0, state.posts.length - CHANNEL_HISTORY_CAP);
		}
		return {
			state: {
				channel: state.channel,
				subscribers: [...state.subscribers],
				posts: [...state.posts],
			},
			post,
		};
	}
}

export function formatChannelListMarkdown(channels: readonly ChannelSummary[]): string {
	if (channels.length === 0) {
		return "No active channels.\nSubscribe with `write agent://channel/<topic>?subscribe` or post with `write agent://channel/<topic>`.";
	}
	const lines = ["# Active Agent Channels", ""];
	for (const item of channels) {
		const subs = item.subscribers.length > 0 ? item.subscribers.join(", ") : "none";
		lines.push(
			`- \`#${item.channel}\` — ${item.messageCount} post(s), subscribers (${item.subscribers.length}): ${subs}`,
		);
	}
	return lines.join("\n");
}

export function formatChannelFeedMarkdown(state: ChannelState): string {
	const subs = state.subscribers.length > 0 ? state.subscribers.join(", ") : "none";
	const lines = [`# Channel #${state.channel}`, `Subscribers (${state.subscribers.length}): ${subs}`, ""];
	if (state.posts.length === 0) {
		lines.push("_No posts yet._");
		return lines.join("\n");
	}
	for (const post of state.posts) {
		const iso = new Date(post.ts).toISOString();
		lines.push(`### [${post.id}] ${post.from} (${iso})`, post.body, "");
	}
	return lines.join("\n").trimEnd();
}

/** Resolve the primary artifacts directory for channel persistence when available. */
export function resolveChannelArtifactsDir(options: {
	artifactsDir?: string | null;
	sessionFile?: string | null;
}): string | null {
	if (options.artifactsDir) return options.artifactsDir;
	if (options.sessionFile?.endsWith(".jsonl")) return options.sessionFile.slice(0, -6);
	return null;
}

/** Publish a message to `#<channel>` and deliver `[#<channel>] <body>` to all subscribed peers. */
export async function publishChannelMessage(
	deps: {
		registry: AgentRegistryApi;
		senderId: string;
		sessionFileHint?: string | null;
		artifactsDir?: string | null;
	},
	params: { channel: string; message: string },
): Promise<AgentToolResult<CoordinationDetails>> {
	const { registry, senderId, sessionFileHint } = deps;
	const topic = normalizeChannelTopic(params.channel);
	const body = params.message;
	if (!body.trim()) {
		return {
			content: [{ type: "text", text: "A non-empty message is required to post to a channel." }],
			details: { op: "send", from: senderId, to: `#${topic}` },
			isError: true,
		};
	}
	const artifactsDir = resolveChannelArtifactsDir({
		artifactsDir: deps.artifactsDir,
		sessionFile: sessionFileHint,
	});
	const { state } = await ChannelBoard.global().appendPost(topic, senderId, body, artifactsDir);
	const targets = state.subscribers.filter(id => id !== senderId);

	if (targets.length > 0 && sessionFileHint) {
		const needsRoster = targets.some(id => {
			const ref = registry.get(id);
			return !ref || ref.status === "parked";
		});
		if (needsRoster) {
			await ensurePersistedRoster(registry, sessionFileHint);
		}
	}

	const bus = IrcBus.global();
	const taggedBody = `[#${topic}] ${body}`;
	const receipts: IrcDeliveryReceipt[] = await Promise.all(
		targets.map(target =>
			bus.send({
				from: senderId,
				to: target,
				body: taggedBody,
				broadcast: true,
			}),
		),
	);
	const delivered = receipts.filter(receipt => receipt.outcome !== "failed");
	let text =
		targets.length === 0
			? `Posted to #${topic} (recorded on channel feed; no other subscribers yet).`
			: `Posted to #${topic}; delivered to ${delivered.length} of ${targets.length} subscriber(s).`;
	if (receipts.length > 0) {
		text += `\n${receipts
			.map(receipt =>
				receipt.outcome === "failed"
					? `- ${receipt.to}: failed — ${receipt.error ?? "not running"}`
					: `- ${receipt.to}: ${receipt.outcome}`,
			)
			.join("\n")}`;
	}
	return {
		content: [{ type: "text", text }],
		details: { op: "send", from: senderId, to: `#${topic}`, receipts },
		isError: false,
	};
}
