export type SwarmRole = "coordinator" | "worker" | "narrator" | "monitor";

export type SwarmWakeMode = "mentions" | "anything";

export type SwarmWorkspaceMode = "inherit" | "share" | "branch";

export type SwarmMemberStatus = "waiting" | "working" | "stopped" | "killed";

export type SwarmChannelOp = "create" | "archive" | "subscribe" | "unsubscribe" | "list";

export interface SwarmChannelControl {
	op: "create" | "archive" | "subscribe" | "unsubscribe";
	channel: string;
	topic?: string;
	actor: string;
	members?: string[];
	prev?: Record<string, string[] | null>;
	next?: Record<string, string[] | null>;
}

export type SwarmMessageKind = "post" | "brief" | "control";

export interface SwarmBoardMessage {
	seq: number;
	agent: string;
	text: string;
	time: string;
	kind?: SwarmMessageKind;
	channel?: string;
	control?: SwarmChannelControl;
}

export interface SwarmChannelInfo {
	name: string;
	topic: string;
	created_by: string;
	archived: boolean;
}

export interface SwarmMemberRecord {
	name: string;
	agent_id: string;
	conversation_id: string;
	role: SwarmRole;
	added_by: string;
	model: string;
	workspace: SwarmWorkspaceMode;
	channels: string[] | null;
	wake_mode: SwarmWakeMode;
	wait_since: number;
	last_read_seq: number;
	last_post_seq?: number;
	last_post_time?: string;
	killed: boolean;
	last_error?: string;
	quota_exhausted?: boolean;
	workspace_note?: string;
	updated_at: string;
}

export interface SwarmRosterFile {
	swarm_id: string;
	title: string;
	created_at: string;
	channels: SwarmChannelInfo[];
	members: Record<string, SwarmMemberRecord>;
}

export type SwarmAttentionKind = "decision" | "failure" | "review" | "stuck" | "quota" | "error" | "fyi";
export type SwarmAttentionSeverity = "high" | "med" | "low";
export type SwarmWorkstreamState = "queued" | "active" | "blocked" | "review" | "done" | "failed";

export interface SwarmRef {
	seq?: number;
	member?: string;
	unverified?: boolean;
}

export interface SwarmShortCopy {
	title: string;
	line: string;
}

export interface SwarmAttentionItem {
	id: string;
	kind: SwarmAttentionKind;
	severity: SwarmAttentionSeverity;
	title: string;
	why?: string;
	short?: SwarmShortCopy;
	refs: SwarmRef[];
	uncited?: boolean;
}

export interface SwarmWorkstreamItem {
	id: string;
	title: string;
	owners: string[];
	state: SwarmWorkstreamState;
	note?: string;
	short?: SwarmShortCopy;
	progress?: { done: number; total: number };
	refs: SwarmRef[];
	uncited?: boolean;
}

export interface SwarmThreadItem {
	id: string;
	title: string;
	goal?: string;
	now?: string;
	workstreams: string[];
	attention: string[];
}

export interface SwarmNoteItem {
	id: string;
	text: string;
	refs: SwarmRef[];
}

export interface SwarmOverviewView {
	version: number;
	as_of_seq: number;
	updated_at: string;
	headline: string;
	goal?: { title: string; line: string };
	running_summary?: string;
	phase?: { label: string; index: number; total: number };
	threads?: SwarmThreadItem[];
	attention: SwarmAttentionItem[];
	workstreams: SwarmWorkstreamItem[];
	milestones: SwarmNoteItem[];
	risks: SwarmNoteItem[];
	now?: Record<string, string>;
	feedback_ack?: { through_seq: number; text: string };
	stale_fallback?: boolean;
}

export interface SwarmToolDetails {
	tool: "swarm" | "post_message" | "read_board" | "swarm_wait";
	action?: string;
	swarmDir?: string;
	swarmId?: string;
	actor?: string;
	seq?: number;
	head?: number;
	added?: string[];
	killed?: string[];
	channel?: string;
	interrupted?: boolean;
}
