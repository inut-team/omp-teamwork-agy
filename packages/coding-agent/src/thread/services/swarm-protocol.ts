import type {
	SwarmAddMembersInput,
	SwarmEnsureInput,
	SwarmModelSwitchNotifyInput,
	SwarmParkTurnInput,
	SwarmPostInput,
	SwarmSnapshotResult,
	SwarmWaitSignalInput,
} from "../../swarm/hub";
import type { ReadViewResult } from "../../swarm/store";
import type {
	SwarmAutoParkResult,
	SwarmBoardMessage,
	SwarmChannelOp,
	SwarmHeadLagResult,
	SwarmMemberRecord,
	SwarmMemberStatus,
	SwarmOverviewView,
	SwarmParkTurnResult,
	SwarmRosterFile,
	SwarmWaitSignalEvent,
	SwarmWakeMode,
} from "../../swarm/types";
import type { RpcMethod } from "../rpc";

/** Remote-object kind of the main-thread {@link SwarmHub}. */
export const SWARM_HUB_KIND = "swarm-hub";

/** {@link SwarmHubApi} over a subagent worker RPC link. */
export type SwarmHubProtocol = {
	ensureCoordinatorSwarm: RpcMethod<[swarmDir: string, params: SwarmEnsureInput], SwarmRosterFile>;
	getSnapshot: RpcMethod<[swarmDir: string], SwarmSnapshotResult>;
	setTitle: RpcMethod<[swarmDir: string, actor: string, title: string], SwarmRosterFile>;
	addMembersWithBrief: RpcMethod<
		[swarmDir: string, params: SwarmAddMembersInput],
		{ roster: SwarmRosterFile; briefMessage: SwarmBoardMessage }
	>;
	postMessage: RpcMethod<
		[swarmDir: string, params: SwarmPostInput],
		{ message: SwarmBoardMessage; roster: SwarmRosterFile; warnings: string[] }
	>;
	readView: RpcMethod<
		[
			swarmDir: string,
			params: {
				readonly memberName: string;
				readonly since?: number;
				readonly limit?: number;
				readonly seqs?: number[];
				readonly channel?: string;
				readonly advanceCursor?: boolean;
			},
		],
		ReadViewResult
	>;
	readNarratorOverview: RpcMethod<[swarmDir: string, head: number, memberNames: string[]], SwarmOverviewView | null>;
	executeChannelOp: RpcMethod<
		[
			swarmDir: string,
			params: {
				readonly actor: string;
				readonly op: SwarmChannelOp;
				readonly channel?: string;
				readonly topic?: string;
				readonly targetMember?: string;
			},
		],
		{ text: string; roster: SwarmRosterFile; message?: SwarmBoardMessage }
	>;
	markKilled: RpcMethod<[swarmDir: string, names: readonly string[]], SwarmRosterFile | null>;
	updateMemberFields: RpcMethod<
		[
			swarmDir: string,
			memberName: string,
			patch: Partial<
				Pick<
					SwarmMemberRecord,
					"model" | "last_error" | "quota_exhausted" | "sit_out_until_seq" | "workspace_note" | "agent_id"
				>
			>,
		],
		SwarmMemberRecord | null
	>;
	recordWait: RpcMethod<[swarmDir: string, memberName: string, since: number, wakeMode: SwarmWakeMode], void>;
	registerAgentBinding: RpcMethod<[swarmDir: string, agentId: string, memberName: string], void>;
	resolveActorName: RpcMethod<
		[swarmDir: string, agentId: string, taskDepth: number, explicitMemberName?: string],
		string
	>;
	checkHeadLag: RpcMethod<[swarmDir: string, memberName: string, seenHeadWatermark: number], SwarmHeadLagResult>;
	parkMemberTurn: RpcMethod<[swarmDir: string, params: SwarmParkTurnInput], SwarmParkTurnResult>;
	checkAutoParkOnStop: RpcMethod<
		[swarmDir: string, params: { readonly memberName: string; readonly isWorker: boolean }],
		SwarmAutoParkResult
	>;
	waitForBoardSignal: RpcMethod<[swarmDir: string, params: SwarmWaitSignalInput], SwarmWaitSignalEvent>;
	notifyModelSwitched: RpcMethod<[swarmDir: string, params: SwarmModelSwitchNotifyInput], void>;
	notifyKilled: RpcMethod<[swarmDir: string, memberName: string], void>;
	isParked: RpcMethod<[swarmDir: string, memberName: string], boolean>;
	waitUntilParked: RpcMethod<[swarmDir: string, memberName: string], void>;
	getMemberStatus: RpcMethod<[swarmDir: string, member: SwarmMemberRecord], SwarmMemberStatus>;
	hasActiveSwarmMembers: RpcMethod<[swarmDir: string], boolean>;
	reportMemberTurnError: RpcMethod<[swarmDir: string, memberName: string, errorText: string, isQuota: boolean], void>;
	clearMemberError: RpcMethod<[swarmDir: string, memberName: string], void>;
};
