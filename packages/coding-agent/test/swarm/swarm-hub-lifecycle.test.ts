import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type Api,
	type AssistantMessage,
	clearCustomApis,
	type Model,
	type ModelSpec,
	registerCustomApi,
} from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { clearOmpExtensionCliRoots } from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { type AgentRegistryApi, AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { type CreateAgentSessionOptions, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionHandle } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { expandAgyCompatSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-agy-compat";
import {
	promoteSwarmToolsOnSession,
	resolveSwarmDir,
	SWARM_TOOL_NAMES,
	SwarmHub,
	SwarmRuntime,
	SwarmTool,
	type SwarmWakeNotice,
	SwarmWaitTool,
} from "@oh-my-pi/pi-coding-agent/swarm";
import { swarmThreadService } from "@oh-my-pi/pi-coding-agent/thread/services/swarm";
import type { Tool, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { SwarmWorkerProbe } from "../fixtures/swarm-hub-worker";
import { createAssistantMessage } from "../helpers/agent-session-setup";
import { type ServiceWorker, startServiceWorker } from "../helpers/service-worker";

function makeCustomModel(api: string, id = "swarm-test-model"): Model<Api> {
	return buildModel({
		id,
		name: `Swarm Test (${id})`,
		api,
		provider: "llama.cpp",
		baseUrl: "http://127.0.0.1:8080/v1",
		reasoning: false,
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 16384,
		maxTokens: 2048,
	} as ModelSpec<Api>) as Model<Api>;
}

function streamOf(message: AssistantMessage, beforeDone?: () => void | Promise<void>): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(async () => {
		if (beforeDone) await beforeDone();
		stream.push({ type: "start", partial: message });
		message.content.forEach((block, contentIndex) => {
			if (block.type === "toolCall") {
				stream.push({ type: "toolcall_start", contentIndex, partial: message });
				stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: message });
			}
		});
		stream.push({
			type: "done",
			reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
			message,
		});
	});
	return stream;
}

function makeToolSession(options: {
	cwd: string;
	artifactsDir: string;
	agentId: string;
	taskDepth: number;
	registry: AgentRegistryApi;
	parkOnSwarmWait?: boolean;
	activeTools?: Set<string>;
	mountedTools?: Set<string>;
	swarmContext?: { swarmDir: string; memberName: string };
	modelRegistry?: ModelRegistry;
	activeModel?: string;
}): ToolSession {
	const activeTools = options.activeTools ?? new Set<string>(["read", "write"]);
	const mountedTools = options.mountedTools ?? new Set<string>(SWARM_TOOL_NAMES);
	const toolRegistry = new Map<string, Tool>();
	for (const name of [...activeTools, ...mountedTools]) {
		toolRegistry.set(name, {} as Tool);
	}
	return {
		cwd: options.cwd,
		hasUI: false,
		settings: Settings.isolated({}),
		taskDepth: options.taskDepth,
		agentRegistry: options.registry,
		modelRegistry: options.modelRegistry,
		parkOnSwarmWait: options.parkOnSwarmWait,
		swarmContext: options.swarmContext,
		setSwarmContext: ctx => {
			options.swarmContext = ctx;
		},
		getAgentId: () => options.agentId,
		getSessionFile: () => path.join(options.artifactsDir, `${options.agentId}.jsonl`),
		getSessionId: () => options.agentId,
		getArtifactsDir: () => options.artifactsDir,
		localProtocolOptions: {
			getArtifactsDir: () => options.artifactsDir,
			getSessionId: () => "root-session",
		},
		getSessionSpawns: () => "*",
		getActiveModelString: () => options.activeModel ?? "apphub/ag/gemini-4-carbon-400k",
		getModelString: () => options.activeModel ?? "apphub/ag/gemini-4-carbon-400k",
		toolRegistry,
		xdev: {
			tools: toolRegistry,
			mountedNames: mountedTools,
			builtInNames: new Set(SWARM_TOOL_NAMES),
			isActive: name => activeTools.has(name),
		},
		isToolActive: name => activeTools.has(name),
		setActiveToolNames: names => {
			activeTools.clear();
			for (const n of names) activeTools.add(n);
		},
	};
}

describe("SwarmHub cross-thread & lifecycle contracts", () => {
	const tempDirs: TempDir[] = [];
	const authStorages: AuthStorage[] = [];
	const sessions: AgentSession[] = [];
	const workers: ServiceWorker<SwarmWorkerProbe>[] = [];
	let registry: AgentRegistryApi;
	beforeEach(() => {
		SwarmRuntime.resetForTests();
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		registry = AgentRegistry.global();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: "Main",
			kind: "main",
			session: null,
			status: "idle",
		});
	});

	afterEach(async () => {
		clearCustomApis();
		clearOmpExtensionCliRoots();
		for (const worker of workers.splice(0)) {
			await worker.stop();
		}
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
		for (const auth of authStorages.splice(0)) {
			auth.close();
		}
		SwarmRuntime.resetForTests();
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		for (const dir of tempDirs.splice(0)) {
			dir.removeSync();
		}
	});

	async function createRealWorkerSession(
		api: string,
		responses: AssistantMessage[],
		extra: Partial<CreateAgentSessionOptions> = {},
		onCall?: (
			callIdx: number,
			contextMessages: ReadonlyArray<{ role: string; content: unknown }>,
		) => void | Promise<void>,
	): Promise<{
		session: AgentSession;
		tempDir: TempDir;
		modelRegistry: ModelRegistry;
		calls: () => number;
		observedMessages: () => number;
	}> {
		const tempDir = TempDir.createSync("@omp-swarm-session-");
		tempDirs.push(tempDir);
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const model = makeCustomModel(api);
		let calls = 0;
		let lastContextLen = 0;
		registerCustomApi(api, (_model, context) => {
			const idx = calls++;
			lastContextLen = context.messages.length;
			const msg = responses[Math.min(idx, responses.length - 1)]!;
			return streamOf(msg, () => onCall?.(idx, context.messages));
		});
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false }),
			model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: ["read", "swarm", "post_message", "read_board", "swarm_wait"],
			...extra,
		});
		sessions.push(session);
		return {
			session,
			tempDir,
			modelRegistry,
			calls: () => calls,
			observedMessages: () => lastContextLen,
		};
	}

	it("bridges SwarmHub across a real Bun worker thread (waiters, parking, quota errors, kill)", async () => {
		const tempDir = TempDir.createSync("@omp-swarm-worker-thread-");
		tempDirs.push(tempDir);
		const artifactsDir = path.join(tempDir.path(), "artifacts");
		await fs.mkdir(artifactsDir, { recursive: true });

		const coordSession = makeToolSession({
			cwd: tempDir.path(),
			artifactsDir,
			agentId: MAIN_AGENT_ID,
			taskDepth: 0,
			registry,
		});
		const runtime = SwarmRuntime.forSession(coordSession);
		await runtime.ensureCoordinatorSwarm(coordSession, "Thread Bridge Test");

		const wokeNotices: SwarmWakeNotice[] = [];
		const workerHandle: AgentSessionHandle = {
			deliverSwarmWake: async (notice: SwarmWakeNotice) => {
				wokeNotices.push(notice);
			},
		} as unknown as AgentSessionHandle;

		registry.register({
			id: "worker-a",
			displayName: "worker-a",
			kind: "sub",
			session: workerHandle,
			status: "running",
			parentId: MAIN_AGENT_ID,
		});

		await SwarmHub.global().addMembersWithBrief(runtime.dir, {
			actor: "coordinator",
			senderAgentId: MAIN_AGENT_ID,
			briefText: "@worker-a build the cache module",
			briefChannel: "main",
			newMembers: [
				{
					name: "worker-a",
					agent_id: "worker-a",
					conversation_id: "worker-a",
					role: "worker",
					added_by: "coordinator",
					model: "apphub/ag/gemini-4-carbon-400k",
					workspace: "inherit",
					channels: null,
					wake_mode: "mentions",
					killed: false,
				},
			],
		});

		const fixture = await startServiceWorker<SwarmWorkerProbe>(
			new URL("../fixtures/swarm-hub-worker.ts", import.meta.url),
			[swarmThreadService],
		);
		workers.push(fixture);
		const probe = fixture.probe;
		expect(await probe.isMain()).toBe(false);

		// 1. Worker posts to board via RemoteSwarmHub -> wakes coordinator waiter on main thread
		const coordWaitPromise = SwarmHub.global().waitForBoardSignal(runtime.dir, {
			memberName: "coordinator",
			since: 1,
			mentionsOnly: true,
		});
		await SwarmHub.global().waitUntilParked(runtime.dir, "coordinator");
		const posted = await probe.postAs(runtime.dir, "worker-a", "@coordinator cache PR ready (#1)", "worker-a");
		expect(posted.seq).toBe(2);
		const coordWake = await coordWaitPromise;
		expect(coordWake.kind).toBe("message");
		if (coordWake.kind === "message") {
			expect(coordWake.message.seq).toBe(2);
			expect(coordWake.message.agent).toBe("worker-a");
		}

		// 2. Coordinator posts an unmentioned post #3 -> worker checks head lag & parks via RemoteSwarmHub
		await SwarmHub.global().postMessage(runtime.dir, {
			actor: "coordinator",
			text: "FYI architecture notes for anyone reading",
			senderAgentId: MAIN_AGENT_ID,
		});
		const lagBefore = await probe.checkHeadLag(runtime.dir, "worker-a", 1);
		expect(lagBefore.hasUnreadVisible).toBe(true);
		const read = await probe.readAs(runtime.dir, "worker-a", 1);
		expect(read.seqs).toEqual([2, 3]);

		const parkRes = await probe.parkTurn(runtime.dir, "worker-a", 3, true);
		expect(parkRes.parked).toBe(true);
		expect(await probe.isParked(runtime.dir, "worker-a")).toBe(true);

		// 3. Coordinator @mentions parked worker -> main SwarmHub clears parked state & calls workerHandle.deliverSwarmWake
		await SwarmHub.global().postMessage(runtime.dir, {
			actor: "coordinator",
			text: "@worker-a please add TTL eviction",
			senderAgentId: MAIN_AGENT_ID,
		});
		expect(await probe.isParked(runtime.dir, "worker-a")).toBe(false);
		expect(wokeNotices[0]?.text).toContain("#4");
		expect(wokeNotices[0]?.text).toContain("@coordinator");

		// 4. Quota error reporting and active-members tracking across threads
		expect(await probe.hasActiveMembers(runtime.dir)).toBe(true);
		await probe.reportError(runtime.dir, "worker-a", "HTTP 429 RESOURCE_EXHAUSTED quota exhausted");
		let snap = await SwarmHub.global().getSnapshot(runtime.dir);
		expect(snap.roster?.members["worker-a"]?.quota_exhausted).toBe(true);
		await probe.clearError(runtime.dir, "worker-a");
		snap = await SwarmHub.global().getSnapshot(runtime.dir);
		expect(snap.roster?.members["worker-a"]?.quota_exhausted).toBe(false);

		// 5. Killing worker removes active swarm member state
		await probe.markKilled(runtime.dir, ["worker-a"]);
		expect(await probe.hasActiveMembers(runtime.dir)).toBe(false);
	}, 20_000);

	it("supports park-on-yield swarm_wait, timeout_ms wakeup, and model-switch clearing quota_exhausted", async () => {
		const tempDir = TempDir.createSync("@omp-swarm-park-");
		tempDirs.push(tempDir);
		const artifactsDir = path.join(tempDir.path(), "artifacts");
		await fs.mkdir(artifactsDir, { recursive: true });

		const coordSession = makeToolSession({
			cwd: tempDir.path(),
			artifactsDir,
			agentId: MAIN_AGENT_ID,
			taskDepth: 0,
			registry,
		});
		const runtime = SwarmRuntime.forSession(coordSession);
		await runtime.ensureCoordinatorSwarm(coordSession, "Park & Timeout");

		const delivered: SwarmWakeNotice[] = [];
		const switchedModels: Array<{ provider: string; id: string }> = [];
		const workerModel = makeCustomModel("park-api", "replacement-model");
		const workerHandle: AgentSessionHandle = {
			deliverSwarmWake: async (notice: SwarmWakeNotice) => {
				delivered.push(notice);
			},
			setModel: async (m: Model) => {
				switchedModels.push({ provider: m.provider, id: m.id });
				return { switched: true };
			},
		} as unknown as AgentSessionHandle;

		registry.register({
			id: "scout",
			displayName: "scout",
			kind: "sub",
			session: workerHandle,
			status: "running",
			parentId: MAIN_AGENT_ID,
		});

		await SwarmHub.global().addMembersWithBrief(runtime.dir, {
			actor: "coordinator",
			senderAgentId: MAIN_AGENT_ID,
			briefText: "@scout audit api latency",
			briefChannel: "main",
			newMembers: [
				{
					name: "scout",
					agent_id: "scout",
					conversation_id: "scout",
					role: "worker",
					added_by: "coordinator",
					model: "apphub/ag/gemini-4-carbon-400k",
					workspace: "inherit",
					channels: null,
					wake_mode: "mentions",
					killed: false,
				},
			],
		});

		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		modelRegistry.registerProvider(workerModel.provider, {
			baseUrl: "http://127.0.0.1:8080/v1",
			apiKey: "test-key",
			api: workerModel.api,
			models: [
				{
					id: workerModel.id,
					name: workerModel.name,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 16384,
					maxTokens: 2048,
				},
			],
		});
		const workerSession = makeToolSession({
			cwd: path.join(tempDir.path(), "isolated-worktree"),
			artifactsDir: path.join(tempDir.path(), "unrelated-worker-artifacts"),
			agentId: "scout",
			taskDepth: 1,
			registry,
			parkOnSwarmWait: true,
			swarmContext: { swarmDir: runtime.dir, memberName: "scout" },
			modelRegistry,
		});

		// `resolveSwarmDir` must follow `swarmContext.swarmDir`, ignoring different cwd/artifactsDir
		expect(resolveSwarmDir(workerSession)).toBe(path.resolve(runtime.dir));

		const waitTool = new SwarmWaitTool(workerSession);
		const parkRes = await waitTool.execute("w1", { since: 1, mentions_only: true, timeout_ms: 40 });
		expect(parkRes.isError).toBeUndefined();
		expect(parkRes.details?.parked).toBe(true);
		expect(parkRes.details?.waitSince).toBe(1);
		expect(parkRes.details?.timeoutMs).toBe(40);
		expect(await runtime.isParked("scout")).toBe(true);

		// Wait past timeout_ms -> Hub fires timeout wake notice with board head & last_read_seq
		await Bun.sleep(90);
		expect(delivered.length).toBe(1);
		expect(delivered[0]?.isTimeout).toBe(true);
		expect(delivered[0]?.text).toContain("your cursor is #1");

		// Simulate quota exhaustion, then switch model via SwarmTool -> calls setModel, clears error, delivers notice
		await SwarmHub.global().reportMemberTurnError(runtime.dir, "scout", "429 RESOURCE_EXHAUSTED", true);
		const parkAgain = await waitTool.execute("w2", { since: 1, mentions_only: true });
		expect(parkAgain.details?.parked).toBe(true);

		const coordWithReg = makeToolSession({
			cwd: tempDir.path(),
			artifactsDir,
			agentId: MAIN_AGENT_ID,
			taskDepth: 0,
			registry,
			modelRegistry,
		});
		const coordSwarm = new SwarmTool(coordWithReg);
		const switchRes = await coordSwarm.execute("m1", {
			action: "model",
			name: "scout",
			model: `${workerModel.provider}/${workerModel.id}`,
		});
		expect(switchRes.isError).toBeUndefined();
		expect(switchedModels).toEqual([{ provider: workerModel.provider, id: workerModel.id }]);
		const afterSnap = await SwarmHub.global().getSnapshot(runtime.dir);
		expect(afterSnap.roster?.members.scout?.quota_exhausted).toBe(false);
		expect(afterSnap.roster?.members.scout?.last_error).toBeUndefined();
		expect(delivered.some(n => n.isModelSwitch && n.text.includes(workerModel.id))).toBe(true);
	});

	it("keeps board/roster clean on spawnMembers preflight failure and promotes swarm tools headlessly", async () => {
		const tempDir = TempDir.createSync("@omp-swarm-preflight-");
		tempDirs.push(tempDir);
		const artifactsDir = path.join(tempDir.path(), "artifacts");
		await fs.mkdir(artifactsDir, { recursive: true });

		const activeTools = new Set<string>(["read", "write"]);
		const mountedTools = new Set<string>(SWARM_TOOL_NAMES);
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const baseModel = makeCustomModel("preflight-api", "base-model");
		modelRegistry.registerProvider(baseModel.provider, {
			baseUrl: "http://127.0.0.1:8080/v1",
			apiKey: "test-key",
			api: baseModel.api,
			models: [
				{
					id: baseModel.id,
					name: baseModel.name,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 16384,
					maxTokens: 2048,
				},
			],
		});

		const coordSession = makeToolSession({
			cwd: tempDir.path(),
			artifactsDir,
			agentId: MAIN_AGENT_ID,
			taskDepth: 0,
			registry,
			activeTools,
			mountedTools,
			modelRegistry,
		});
		const runtime = SwarmRuntime.forSession(coordSession);

		// Headless `/swarm` expansion + tool promotion work without TUI (hasUI === false)
		const expanded = await expandAgyCompatSlashCommand("/swarm Implement auth middleware", tempDir.path());
		await promoteSwarmToolsOnSession(coordSession);
		expect(expanded).toContain("Implement auth middleware");
		for (const name of SWARM_TOOL_NAMES) {
			expect(activeTools.has(name)).toBe(true);
			expect(mountedTools.has(name)).toBe(false);
		}

		// Invalid workspace for narrator observer must reject BEFORE creating roster or brief message
		let observerErr = "";
		try {
			await runtime.spawnMembers({
				session: coordSession,
				name: "narrator",
				brief: "summarize progress",
				workspace: "share",
			});
		} catch (err) {
			observerErr = err instanceof Error ? err.message : String(err);
		}
		expect(observerErr).toMatch(/narrator and monitor observers must use workspace "inherit"/);
		expect((await SwarmHub.global().getSnapshot(runtime.dir)).roster).toBeNull();

		// Invalid unknown model must also reject BEFORE creating roster or brief message
		let modelErr = "";
		try {
			await runtime.spawnMembers({
				session: coordSession,
				name: "coder",
				brief: "write auth module",
				model: "nonexistent/model-xyz",
			});
		} catch (err) {
			modelErr = err instanceof Error ? err.message : String(err);
		}
		expect(modelErr).toMatch(/unknown model/);
		expect((await SwarmHub.global().getSnapshot(runtime.dir)).roster).toBeNull();
	});

	it("wires AgentSession HeadHook steering, ParkGuard stop nudge, and self model switch end-to-end", async () => {
		const tempDir = TempDir.createSync("@omp-swarm-agent-session-");
		tempDirs.push(tempDir);
		const swarmDir = path.join(tempDir.path(), "swarm");
		await SwarmHub.global().ensureCoordinatorSwarm(swarmDir, {
			coordinatorAgentId: MAIN_AGENT_ID,
			coordinatorConversationId: "root",
			model: "llama.cpp/swarm-test-model",
		});
		await SwarmHub.global().addMembersWithBrief(swarmDir, {
			actor: "coordinator",
			senderAgentId: MAIN_AGENT_ID,
			briefText: "@worker execute task and wait",
			briefChannel: "main",
			newMembers: [
				{
					name: "worker",
					agent_id: "worker",
					conversation_id: "worker",
					role: "worker",
					added_by: "coordinator",
					model: "llama.cpp/swarm-test-model",
					workspace: "inherit",
					channels: null,
					wake_mode: "mentions",
					killed: false,
				},
			],
		});

		const plainEnd = createAssistantMessage("Finished draft, stopping without calling swarm_wait.");
		const readCall: AssistantMessage = {
			...createAssistantMessage(""),
			content: [{ type: "toolCall", id: "c1", name: "read_board", arguments: { since: 0 } }],
			stopReason: "toolUse",
		};
		const statusCall: AssistantMessage = {
			...createAssistantMessage(""),
			content: [{ type: "toolCall", id: "c2", name: "swarm", arguments: { action: "status" } }],
			stopReason: "toolUse",
		};
		const parkWaitCall: AssistantMessage = {
			...createAssistantMessage(""),
			content: [{ type: "toolCall", id: "c3", name: "swarm_wait", arguments: { since: 3, mentions_only: true } }],
			stopReason: "toolUse",
		};
		const wakeReadCall: AssistantMessage = {
			...createAssistantMessage(""),
			content: [{ type: "toolCall", id: "c3b", name: "read_board", arguments: { since: 3 } }],
			stopReason: "toolUse",
		};
		const switchCall: AssistantMessage = {
			...createAssistantMessage(""),
			content: [
				{
					type: "toolCall",
					id: "c4",
					name: "swarm",
					arguments: { action: "model", model: "llama.cpp/alt-model" },
				},
			],
			stopReason: "toolUse",
		};
		const settleSwitch = createAssistantMessage("Switching model now.");
		const afterSwitch = createAssistantMessage("Continuing on alt-model.");

		const seenHeadNudgeOnTurn3 = { matched: false };
		const altModel = makeCustomModel("agent-swarm-api", "alt-model");
		const created = await createRealWorkerSession(
			"agent-swarm-api",
			[plainEnd, readCall, statusCall, parkWaitCall, wakeReadCall, switchCall, settleSwitch, afterSwitch],
			{
				agentId: "worker",
				taskDepth: 1,
				agentRegistry: registry,
				swarmContext: { swarmDir, memberName: "worker" },
			},
			async (idx, contextMessages) => {
				if (idx === 2) {
					// Post #3 while call 2 (`swarm status`) runs so HeadHook fires on boundary === "work" before call 3
					await SwarmHub.global().postMessage(swarmDir, {
						actor: "coordinator",
						text: "FYI architecture spec updated (#3)",
						senderAgentId: MAIN_AGENT_ID,
					});
				}
				if (idx === 3) {
					seenHeadNudgeOnTurn3.matched = contextMessages.some(m =>
						JSON.stringify(m.content).includes("the latest message is #3"),
					);
				}
			},
		);
		created.session.modelRegistry.registerProvider("llama.cpp", {
			baseUrl: "http://127.0.0.1:8080/v1",
			apiKey: "test-key",
			api: altModel.api,
			models: [
				{
					id: altModel.id,
					name: altModel.name,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 16384,
					maxTokens: 2048,
				},
			],
		});

		// Post #2 BEFORE registering worker session so it sits unread when Turn 1 begins (no premature microtask wake race)
		await SwarmHub.global().postMessage(swarmDir, {
			actor: "coordinator",
			text: "@worker also include unit test coverage",
			senderAgentId: MAIN_AGENT_ID,
		});
		if (!registry.get("worker")) {
			registry.register({
				id: "worker",
				displayName: "worker",
				kind: "sub",
				session: created.session,
				status: "running",
				parentId: MAIN_AGENT_ID,
			});
		}

		// Turn 1:
		//  0: plainEnd -> ParkGuard blocks because #2 calls on worker!
		//  1: readCall -> read_board{since: 0} advances cursor to 2
		//  2: statusCall -> HeadHook sees #3 arrive mid-turn and injects swarm:head-nudge before call 3!
		//  3: parkWaitCall -> swarm_wait{since: 3} returns { parked: true } and ends turn immediately at 4 LLM calls!
		await created.session.prompt("Start your slice");
		await created.session.waitForIdle();

		expect(created.calls()).toBe(4);
		expect(seenHeadNudgeOnTurn3.matched).toBe(true);
		const midSnap = await SwarmHub.global().getSnapshot(swarmDir);
		expect(midSnap.roster?.members.worker?.last_read_seq).toBe(3);
		expect(await SwarmHub.global().isParked(swarmDir, "worker")).toBe(true);

		// Wake parked worker via SwarmHub -> worker switches its own model to alt-model, preserving history!
		await SwarmHub.global().postMessage(swarmDir, {
			actor: "coordinator",
			text: "@worker switch to alt-model and wrap up",
			senderAgentId: MAIN_AGENT_ID,
		});
		const deadline = Date.now() + 5_000;
		while (created.calls() < 8 && Date.now() < deadline) {
			await Bun.sleep(20);
		}
		await created.session.waitForIdle();

		expect(created.calls()).toBe(8);
		expect(created.session.model?.id).toBe("alt-model");
		expect(created.observedMessages()).toBeGreaterThan(4);
		const snap = await SwarmHub.global().getSnapshot(swarmDir);
		expect(snap.roster?.members.worker?.model).toContain("alt-model");
	});
});
