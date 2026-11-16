/**
 * Bridges the main thread's authoritative {@link SwarmHub} to Bun subagent
 * workers so every swarm member across threads shares one board store, wait
 * table, parked-turn registry, and wake dispatcher.
 */
import { SwarmHub } from "../../swarm/hub";
import type { WorkerThreadLink } from "../protocol";
import type { RpcServe } from "../rpc";
import type { ThreadService, WorkerPeer } from "../services";
import { SWARM_HUB_KIND, type SwarmHubProtocol } from "./swarm-protocol";
import { RemoteSwarmHub } from "./swarm-remote";

const SERVICE_NAME = "swarm";

const exitedControllers = new Map<WorkerPeer["threadId"], AbortController>();

function serveHub(exited: AbortSignal): RpcServe<SwarmHub, SwarmHubProtocol> {
	return {
		ensureCoordinatorSwarm: (hub, swarmDir, params) => hub.ensureCoordinatorSwarm(swarmDir, params),
		getSnapshot: (hub, swarmDir) => hub.getSnapshot(swarmDir),
		setTitle: (hub, swarmDir, actor, title) => hub.setTitle(swarmDir, actor, title),
		addMembersWithBrief: (hub, swarmDir, params) => hub.addMembersWithBrief(swarmDir, params),
		postMessage: (hub, swarmDir, params) => hub.postMessage(swarmDir, params),
		readView: (hub, swarmDir, params) => hub.readView(swarmDir, params),
		readNarratorOverview: (hub, swarmDir, head, memberNames) => hub.readNarratorOverview(swarmDir, head, memberNames),
		executeChannelOp: (hub, swarmDir, params) => hub.executeChannelOp(swarmDir, params),
		markKilled: (hub, swarmDir, names) => hub.markKilled(swarmDir, names),
		updateMemberFields: (hub, swarmDir, memberName, patch) => hub.updateMemberFields(swarmDir, memberName, patch),
		recordWait: (hub, swarmDir, memberName, since, wakeMode) => hub.recordWait(swarmDir, memberName, since, wakeMode),
		registerAgentBinding: (hub, swarmDir, agentId, memberName) =>
			hub.registerAgentBinding(swarmDir, agentId, memberName),
		resolveActorName: (hub, swarmDir, agentId, taskDepth, explicitMemberName) =>
			hub.resolveActorName(swarmDir, agentId, taskDepth, explicitMemberName),
		checkHeadLag: (hub, swarmDir, memberName, seenHeadWatermark) =>
			hub.checkHeadLag(swarmDir, memberName, seenHeadWatermark),
		parkMemberTurn: (hub, swarmDir, params) => hub.parkMemberTurn(swarmDir, params),
		checkAutoParkOnStop: (hub, swarmDir, params) => hub.checkAutoParkOnStop(swarmDir, params),
		waitForBoardSignal: (hub, swarmDir, params) =>
			hub.waitForBoardSignal(swarmDir, {
				...params,
				signal: params.signal ? AbortSignal.any([params.signal, exited]) : exited,
			}),
		notifyModelSwitched: (hub, swarmDir, params) => hub.notifyModelSwitched(swarmDir, params),
		notifyKilled: (hub, swarmDir, memberName) => hub.notifyKilled(swarmDir, memberName),
		isParked: (hub, swarmDir, memberName) => hub.isParked(swarmDir, memberName),
		waitUntilParked: (hub, swarmDir, memberName) => hub.waitUntilParked(swarmDir, memberName),
		getMemberStatus: (hub, swarmDir, member) => hub.getMemberStatus(swarmDir, member),
		hasActiveSwarmMembers: (hub, swarmDir) => hub.hasActiveSwarmMembers(swarmDir),
		reportMemberTurnError: (hub, swarmDir, memberName, errorText, isQuota) =>
			hub.reportMemberTurnError(swarmDir, memberName, errorText, isQuota),
		clearMemberError: (hub, swarmDir, memberName) => hub.clearMemberError(swarmDir, memberName),
	};
}

export const swarmThreadService: ThreadService = {
	name: SERVICE_NAME,

	installMain(peer: WorkerPeer) {
		const controller = new AbortController();
		exitedControllers.set(peer.threadId, controller);
		peer.link.exportClass(
			SWARM_HUB_KIND,
			(value): value is SwarmHub => value instanceof SwarmHub,
			serveHub(controller.signal),
		);
	},

	globals(): unknown {
		const hub = SwarmHub.global();
		if (!(hub instanceof SwarmHub)) {
			throw new Error("SwarmHub singleton must be the main-thread instance to bridge to a worker");
		}
		return hub;
	},

	onWorkerExit(peer: WorkerPeer, reason: string) {
		const controller = exitedControllers.get(peer.threadId);
		exitedControllers.delete(peer.threadId);
		controller?.abort(new Error(`Subagent worker ${peer.threadId} exited: ${reason}`));
	},

	installWorker(link: WorkerThreadLink) {
		link.importClass<RemoteSwarmHub, SwarmHubProtocol>(SWARM_HUB_KIND, remote => new RemoteSwarmHub(remote));
	},

	boot(globals: unknown) {
		if (!(globals instanceof RemoteSwarmHub)) {
			throw new Error("Malformed swarm thread globals");
		}
		SwarmHub.installGlobal(globals);
	},
};
