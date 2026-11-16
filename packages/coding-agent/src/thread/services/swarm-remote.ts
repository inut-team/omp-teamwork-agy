import type {
	SwarmAddMembersInput,
	SwarmEnsureInput,
	SwarmHubApi,
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
import type { RemoteObject } from "../rpc";
import type { SwarmHubProtocol } from "./swarm-protocol";

/** Worker-thread proxy of the main thread's authoritative {@link SwarmHub}. */
export class RemoteSwarmHub implements SwarmHubApi {
	readonly #remote: RemoteObject<SwarmHubProtocol>;

	constructor(remote: RemoteObject<SwarmHubProtocol>) {
		this.#remote = remote;
	}

	ensureCoordinatorSwarm(swarmDir: string, params: SwarmEnsureInput): Promise<SwarmRosterFile> {
		return this.#remote.call("ensureCoordinatorSwarm", swarmDir, params);
	}

	getSnapshot(swarmDir: string): Promise<SwarmSnapshotResult> {
		return this.#remote.call("getSnapshot", swarmDir);
	}

	setTitle(swarmDir: string, actor: string, title: string): Promise<SwarmRosterFile> {
		return this.#remote.call("setTitle", swarmDir, actor, title);
	}

	addMembersWithBrief(
		swarmDir: string,
		params: SwarmAddMembersInput,
	): Promise<{ roster: SwarmRosterFile; briefMessage: SwarmBoardMessage }> {
		return this.#remote.call("addMembersWithBrief", swarmDir, params);
	}

	postMessage(
		swarmDir: string,
		params: SwarmPostInput,
	): Promise<{ message: SwarmBoardMessage; roster: SwarmRosterFile; warnings: string[] }> {
		return this.#remote.call("postMessage", swarmDir, params);
	}

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
	): Promise<ReadViewResult> {
		return this.#remote.call("readView", swarmDir, params);
	}

	readNarratorOverview(swarmDir: string, head: number, memberNames: string[]): Promise<SwarmOverviewView | null> {
		return this.#remote.call("readNarratorOverview", swarmDir, head, memberNames);
	}

	executeChannelOp(
		swarmDir: string,
		params: {
			readonly actor: string;
			readonly op: SwarmChannelOp;
			readonly channel?: string;
			readonly topic?: string;
			readonly targetMember?: string;
		},
	): Promise<{ text: string; roster: SwarmRosterFile; message?: SwarmBoardMessage }> {
		return this.#remote.call("executeChannelOp", swarmDir, params);
	}

	markKilled(swarmDir: string, names: readonly string[]): Promise<SwarmRosterFile | null> {
		return this.#remote.call("markKilled", swarmDir, names);
	}

	updateMemberFields(
		swarmDir: string,
		memberName: string,
		patch: Partial<
			Pick<
				SwarmMemberRecord,
				"model" | "last_error" | "quota_exhausted" | "sit_out_until_seq" | "workspace_note" | "agent_id"
			>
		>,
	): Promise<SwarmMemberRecord | null> {
		return this.#remote.call("updateMemberFields", swarmDir, memberName, patch);
	}

	recordWait(swarmDir: string, memberName: string, since: number, wakeMode: SwarmWakeMode): Promise<void> {
		return this.#remote.call("recordWait", swarmDir, memberName, since, wakeMode);
	}

	registerAgentBinding(swarmDir: string, agentId: string, memberName: string): void {
		this.#remote.notify("registerAgentBinding", swarmDir, agentId, memberName);
	}

	resolveActorName(
		swarmDir: string,
		agentId: string,
		taskDepth: number,
		explicitMemberName?: string,
	): Promise<string> {
		return this.#remote.call("resolveActorName", swarmDir, agentId, taskDepth, explicitMemberName);
	}

	checkHeadLag(swarmDir: string, memberName: string, seenHeadWatermark: number): Promise<SwarmHeadLagResult> {
		return this.#remote.call("checkHeadLag", swarmDir, memberName, seenHeadWatermark);
	}

	parkMemberTurn(swarmDir: string, params: SwarmParkTurnInput): Promise<SwarmParkTurnResult> {
		return this.#remote.call("parkMemberTurn", swarmDir, params);
	}

	checkAutoParkOnStop(
		swarmDir: string,
		params: { readonly memberName: string; readonly isWorker: boolean },
	): Promise<SwarmAutoParkResult> {
		return this.#remote.call("checkAutoParkOnStop", swarmDir, params);
	}

	waitForBoardSignal(swarmDir: string, params: SwarmWaitSignalInput): Promise<SwarmWaitSignalEvent> {
		return this.#remote.call("waitForBoardSignal", swarmDir, params);
	}

	notifyModelSwitched(swarmDir: string, params: SwarmModelSwitchNotifyInput): Promise<void> {
		return this.#remote.call("notifyModelSwitched", swarmDir, params);
	}

	notifyKilled(swarmDir: string, memberName: string): void {
		this.#remote.notify("notifyKilled", swarmDir, memberName);
	}

	isParked(swarmDir: string, memberName: string): Promise<boolean> {
		return this.#remote.call("isParked", swarmDir, memberName);
	}

	waitUntilParked(swarmDir: string, memberName: string): Promise<void> {
		return this.#remote.call("waitUntilParked", swarmDir, memberName);
	}

	getMemberStatus(swarmDir: string, member: SwarmMemberRecord): SwarmMemberStatus {
		return this.#remote.callSync("getMemberStatus", swarmDir, member);
	}

	hasActiveSwarmMembers(swarmDir: string): Promise<boolean> {
		return this.#remote.call("hasActiveSwarmMembers", swarmDir);
	}

	reportMemberTurnError(swarmDir: string, memberName: string, errorText: string, isQuota: boolean): Promise<void> {
		return this.#remote.call("reportMemberTurnError", swarmDir, memberName, errorText, isQuota);
	}

	clearMemberError(swarmDir: string, memberName: string): Promise<void> {
		return this.#remote.call("clearMemberError", swarmDir, memberName);
	}
}
