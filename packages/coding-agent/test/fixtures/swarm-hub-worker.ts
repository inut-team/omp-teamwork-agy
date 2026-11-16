import { type MessagePort, parentPort } from "node:worker_threads";
import { isSwarmQuotaError, SwarmHub } from "../../src/swarm/hub";
import { isMainThread, setCurrentThreadId } from "../../src/thread/identity";
import type { WorkerThreadLink } from "../../src/thread/protocol";
import { type RpcFrame, RpcLink } from "../../src/thread/rpc";
import { swarmThreadService } from "../../src/thread/services/swarm";

export interface SwarmWorkerProbe {
	isMain(): boolean;
	postAs(swarmDir: string, actor: string, text: string, senderAgentId?: string): Promise<{ seq: number }>;
	readAs(
		swarmDir: string,
		memberName: string,
		since?: number,
	): Promise<{ head: number; seqs: number[]; lastReadSeq: number }>;
	parkTurn(
		swarmDir: string,
		memberName: string,
		since: number,
		mentionsOnly: boolean,
		timeoutMs?: number,
	): Promise<{ parked: boolean; head: number; immediateSeqs: number[] }>;
	checkHeadLag(
		swarmDir: string,
		memberName: string,
		watermark: number,
	): Promise<{ head: number; hasUnreadVisible: boolean; hasConcerning: boolean; firstConcerningSeq?: number }>;
	reportError(swarmDir: string, memberName: string, errorText: string): Promise<void>;
	clearError(swarmDir: string, memberName: string): Promise<void>;
	hasActiveMembers(swarmDir: string): Promise<boolean>;
	markKilled(swarmDir: string, names: string[]): Promise<void>;
	isParked(swarmDir: string, memberName: string): Promise<boolean>;
}

function isTestGlobals(value: unknown): value is { ready(probe: SwarmWorkerProbe): void } {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "ready") === "function";
}

function buildProbe(): SwarmWorkerProbe {
	return {
		isMain: () => isMainThread(),
		postAs: async (swarmDir, actor, text, senderAgentId) => {
			const res = await SwarmHub.global().postMessage(swarmDir, { actor, text, senderAgentId });
			return { seq: res.message.seq };
		},
		readAs: async (swarmDir, memberName, since) => {
			const res = await SwarmHub.global().readView(swarmDir, {
				memberName,
				since,
				advanceCursor: true,
			});
			return {
				head: res.head,
				seqs: res.messages.map(m => m.seq),
				lastReadSeq: res.lastReadSeq,
			};
		},
		parkTurn: async (swarmDir, memberName, since, mentionsOnly, timeoutMs) => {
			const res = await SwarmHub.global().parkMemberTurn(swarmDir, {
				memberName,
				since,
				mentionsOnly,
				timeoutMs,
			});
			return {
				parked: res.parked,
				head: res.head,
				immediateSeqs: res.immediate?.matching.map(m => m.seq) ?? [],
			};
		},
		checkHeadLag: async (swarmDir, memberName, watermark) => {
			const res = await SwarmHub.global().checkHeadLag(swarmDir, memberName, watermark);
			return {
				head: res.head,
				hasUnreadVisible: res.hasUnreadVisible,
				hasConcerning: res.hasConcerning,
				firstConcerningSeq: res.firstConcerningSeq,
			};
		},
		reportError: async (swarmDir, memberName, errorText) => {
			await SwarmHub.global().reportMemberTurnError(swarmDir, memberName, errorText, isSwarmQuotaError(errorText));
		},
		clearError: async (swarmDir, memberName) => {
			await SwarmHub.global().clearMemberError(swarmDir, memberName);
		},
		hasActiveMembers: async swarmDir => SwarmHub.global().hasActiveSwarmMembers(swarmDir),
		markKilled: async (swarmDir, names) => {
			await SwarmHub.global().markKilled(swarmDir, names);
		},
		isParked: async (swarmDir, memberName) => SwarmHub.global().isParked(swarmDir, memberName),
	};
}

const port = parentPort;
if (!port) throw new Error("swarm-hub-worker fixture must run inside a Worker");

port.once("message", (init: { sync: MessagePort; counter: SharedArrayBuffer }) => {
	setCurrentThreadId("w1");
	const link: WorkerThreadLink = new RpcLink(
		{
			send: frame => port.postMessage(frame),
			listen: handler => {
				const listener = (frame: RpcFrame): void => handler(frame);
				port.on("message", listener);
				return () => port.off("message", listener);
			},
		},
		{ name: "swarm-hub-fixture", sync: { port: init.sync, counter: new Int32Array(init.counter) } },
	);
	swarmThreadService.installWorker?.(link);
	link.handle("ping", nonce => nonce);
	link.handle("boot", async globals => {
		await swarmThreadService.boot?.(globals[swarmThreadService.name], link);
		const test = globals.test;
		if (!isTestGlobals(test)) throw new Error("swarm-hub-worker: missing test globals");
		test.ready(buildProbe());
	});
	port.postMessage({ ready: true });
});
