import type { SwarmBoardMessage, SwarmRole } from "./types";

export const SWARM_MAIN_CHANNEL = "main";
export const SWARM_ALL_CHANNELS = "*";

const NAME_RUNE = /[\p{L}\p{Nd}_-]/u;
const WORKER_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const COPY_NAME_RE = /^([a-z0-9][a-z0-9_-]*)-(\d+)$/;
const CHANNEL_NAME_RE = /^[a-z][a-z0-9-]{0,23}$/;
const ROLE_WORKER_NAME_RE = /^(narrator|monitor)(?:-\d+)?$/i;

const RESERVED_CHANNELS = new Set(["main", "all", "here"]);
const ALL_CHANNELS_ROLES = new Set<SwarmRole>(["coordinator", "narrator", "monitor"]);

export const MAX_WORKER_NAME_LENGTH = 32;
export const MAX_CHANNEL_TOPIC_BYTES = 160;

/** Validate a swarm worker roster name (1:1 with Agy 1.5.5 `nativeswarm.validateWorkerName`). */
export function validateWorkerName(rawName: string): string {
	const name = rawName.trim();
	if (!name) {
		throw new Error("name is required");
	}
	if (name === "all") {
		throw new Error(
			'"all" is the broadcast token: a worker named it would be woken by every post and could never be addressed alone',
		);
	}
	if (name === "coordinator") {
		throw new Error('"coordinator" is the root conversation\'s roster name and cannot be given to a worker');
	}
	if (name.startsWith("coordinator-")) {
		throw new Error('names starting with "coordinator-" are reserved for coordinators; name a worker after its job');
	}
	if (name.length > MAX_WORKER_NAME_LENGTH) {
		throw new Error(
			`name "${name}" is longer than ${MAX_WORKER_NAME_LENGTH} characters; name a worker after its job`,
		);
	}
	if (!WORKER_NAME_RE.test(name)) {
		throw new Error(
			`name "${name}" must be lowercase letters, digits, - or _, starting with a letter or digit, so that @${name} addresses it`,
		);
	}
	return name;
}

/** Validate and normalize a scoped swarm channel name (1:1 with `board.ValidateChannelName`). */
export function validateChannelName(rawChannel: string): string {
	const trimmed = rawChannel.trim().replace(/^#+/, "");
	if (RESERVED_CHANNELS.has(trimmed.toLowerCase())) {
		throw new Error(`channel name "${trimmed}" is reserved`);
	}
	if (!CHANNEL_NAME_RE.test(trimmed)) {
		throw new Error(
			`channel name "${trimmed}" must be 1-24 lowercase letters, digits or '-', starting with a letter`,
		);
	}
	return trimmed;
}

/** Normalize a channel filter or target (`""` / `"#main"` -> `"main"`, `"*"` -> `"*"`). */
export function normalizeChannelSelector(rawChannel?: string): string {
	if (!rawChannel) return SWARM_MAIN_CHANNEL;
	const trimmed = rawChannel.trim();
	if (!trimmed) return SWARM_MAIN_CHANNEL;
	if (trimmed === SWARM_ALL_CHANNELS) return SWARM_ALL_CHANNELS;
	const stripped = trimmed.replace(/^#+/, "").toLowerCase();
	if (!stripped || stripped === SWARM_MAIN_CHANNEL) return SWARM_MAIN_CHANNEL;
	return validateChannelName(stripped);
}

/** Return `<prefix>` when `name` is a numbered `<prefix>-<digits>` copy, else `null`. */
export function copyPrefix(name: string): string | null {
	const match = COPY_NAME_RE.exec(name.toLowerCase());
	return match ? match[1]! : null;
}

/** Resolve effective role, supporting role-worker naming (`narrator`, `monitor`, `narrator-2`, etc.). */
export function effectiveRole(name: string, explicitRole?: SwarmRole): SwarmRole {
	if (explicitRole && explicitRole !== "worker") return explicitRole;
	const match = ROLE_WORKER_NAME_RE.exec(name);
	if (match) {
		const kind = match[1]!.toLowerCase();
		if (kind === "narrator" || kind === "monitor") return kind;
	}
	return explicitRole ?? "worker";
}

/** True for system observer members (`narrator`, `monitor`, and their `-N` replacements). */
export function isRoleObserver(name: string, explicitRole?: SwarmRole): boolean {
	const role = effectiveRole(name, explicitRole);
	return role === "narrator" || role === "monitor";
}

/** Effective visible channel set for a member (`["*"]` for coordinator/narrator/monitor, else `["main", ...set]`). */
export function effectiveChannels(
	role: SwarmRole | undefined,
	stored: readonly string[] | null | undefined,
	name: string,
): string[] {
	const resolvedRole = effectiveRole(name, role);
	if (ALL_CHANNELS_ROLES.has(resolvedRole)) return [SWARM_ALL_CHANNELS];
	if (!stored || stored.length === 0) return [SWARM_MAIN_CHANNEL];
	if (stored.includes(SWARM_ALL_CHANNELS)) return [SWARM_ALL_CHANNELS];
	const out = [SWARM_MAIN_CHANNEL];
	for (const ch of stored) {
		if (ch && ch !== SWARM_MAIN_CHANNEL && !out.includes(ch)) {
			out.push(ch);
		}
	}
	return out;
}

/** A member's default posting channel: its first active subscribed channel, else `"main"`. */
export function homeChannelIn(
	storedChannels: readonly string[] | null | undefined,
	isChannelActive: (channel: string) => boolean,
): string {
	if (!storedChannels || storedChannels.length === 0) return SWARM_MAIN_CHANNEL;
	for (const ch of storedChannels) {
		if (ch && ch !== SWARM_MAIN_CHANNEL && ch !== SWARM_ALL_CHANNELS && isChannelActive(ch)) {
			return ch;
		}
	}
	return SWARM_MAIN_CHANNEL;
}

function hasNamedToken(lowerText: string, lowerTarget: string): boolean {
	if (!lowerTarget) return false;
	const needle = `@${lowerTarget}`;
	let pos = 0;
	while (pos <= lowerText.length - needle.length) {
		const idx = lowerText.indexOf(needle, pos);
		if (idx === -1) return false;
		const prev = idx > 0 ? lowerText[idx - 1]! : "";
		const nextIdx = idx + needle.length;
		const next = nextIdx < lowerText.length ? lowerText[nextIdx]! : "";
		if ((!prev || !NAME_RUNE.test(prev)) && (!next || !NAME_RUNE.test(next))) {
			return true;
		}
		pos = idx + 1;
	}
	return false;
}

/** Whether `text` calls on `memberName` by exact `@name`, numbered `@prefix`, or `@all`. */
export function mentionsMember(text: string, memberName: string): boolean {
	const lowerText = text.toLowerCase();
	if (hasNamedToken(lowerText, "all")) return true;
	const lowerMember = memberName.toLowerCase();
	if (hasNamedToken(lowerText, lowerMember)) return true;
	const prefix = copyPrefix(lowerMember);
	return prefix !== null && hasNamedToken(lowerText, prefix);
}

/** Extract direct roster mentions and `@all` broadcast state for `text`. */
export function mentionsOf(text: string, rosterNames: Iterable<string>): { mentions: string[]; all: boolean } {
	const lowerText = text.toLowerCase();
	const all = hasNamedToken(lowerText, "all");
	const mentions: string[] = [];
	for (const name of rosterNames) {
		const lowerName = name.toLowerCase();
		const prefix = copyPrefix(lowerName);
		if (hasNamedToken(lowerText, lowerName) || (prefix !== null && hasNamedToken(lowerText, prefix))) {
			mentions.push(name);
		}
	}
	return { mentions, all };
}

/**
 * Extract `@#channel` mentions in order of first appearance (1:1 with `board.ChannelMentions`).
 * Includes `"main"` so `validatePostMentions` can reject `@#main` explicitly.
 */
export function extractChannelMentions(text: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const lower = text.toLowerCase();
	let pos = 0;
	while (pos < lower.length) {
		const idx = lower.indexOf("@#", pos);
		if (idx === -1) break;
		const prev = idx > 0 ? lower[idx - 1]! : "";
		if (prev && NAME_RUNE.test(prev)) {
			pos = idx + 2;
			continue;
		}
		let end = idx + 2;
		while (end < lower.length && /[a-z0-9-]/.test(lower[end]!)) {
			end += 1;
		}
		const name = lower.slice(idx + 2, end);
		const next = end < lower.length ? lower[end]! : "";
		if (name && (!next || !NAME_RUNE.test(next))) {
			if (name === SWARM_MAIN_CHANNEL || CHANNEL_NAME_RE.test(name)) {
				if (!seen.has(name)) {
					seen.add(name);
					out.push(name);
				}
			}
		}
		pos = Math.max(idx + 2, end);
	}
	return out;
}

/** Validate `@#channel` mentions on a post, rejecting `@#main` and returning non-blocking warnings for dead/unknown channels. */
export function checkChannelMentions(
	text: string,
	channelLookup: (name: string) => { exists: boolean; archived: boolean },
): string[] {
	const mentioned = extractChannelMentions(text);
	const warnings: string[] = [];
	for (const ch of mentioned) {
		if (ch === SWARM_MAIN_CHANNEL) {
			throw new Error("`@#main` is everyone; write `@all`");
		}
		const info = channelLookup(ch);
		if (!info.exists) {
			warnings.push(`\`@#${ch}\` addressed nobody (unknown channel)`);
		} else if (info.archived) {
			warnings.push(`\`@#${ch}\` addressed nobody (archived channel)`);
		}
	}
	return warnings;
}

/** Whether `text` calls on `memberName` via `@name`, `@prefix`, `@all`, or an active `@#channel` in `memberSet`. */
export function mentionsIn(
	text: string,
	memberName: string,
	memberSet: readonly string[],
	isActiveChannel?: (channel: string) => boolean,
): boolean {
	if (mentionsMember(text, memberName)) return true;
	if (!isActiveChannel) return false;
	const chMentions = extractChannelMentions(text);
	if (chMentions.length === 0) return false;
	const seesAll = memberSet.includes(SWARM_ALL_CHANNELS);
	for (const ch of chMentions) {
		if (ch !== SWARM_MAIN_CHANNEL && isActiveChannel(ch) && (seesAll || memberSet.includes(ch))) {
			return true;
		}
	}
	return false;
}

/** Message channel (`""` or undefined means `"main"`). */
export function messageChannelOf(msg: Pick<SwarmBoardMessage, "channel">): string {
	return typeof msg.channel === "string" && msg.channel ? msg.channel : SWARM_MAIN_CHANNEL;
}

/** Whether member `memberName` with effective channel set `memberSet` sees `msg` (`board.SeesIn`). */
export function seesIn(
	memberName: string,
	memberSet: readonly string[],
	msg: SwarmBoardMessage,
	isActiveChannel?: (channel: string) => boolean,
): boolean {
	const ch = messageChannelOf(msg);
	if (ch === SWARM_MAIN_CHANNEL || memberSet.includes(SWARM_ALL_CHANNELS) || memberSet.includes(ch)) {
		return true;
	}
	if (msg.agent === memberName) return true;
	return mentionsIn(msg.text, memberName, memberSet, isActiveChannel);
}

/** Control messages (`[channel] ...`) never count toward unread badges. */
export function countsAsUnread(msg: SwarmBoardMessage): boolean {
	return !msg.control;
}
