import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/agent-protocol";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { ChannelBoard } from "@oh-my-pi/pi-coding-agent/irc/channels";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, type AgentRegistryApi } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { prepareForkFromSession } from "@oh-my-pi/pi-coding-agent/task/fork-from";
import {
	resolveEffectiveSubagentPolicy,
	StructuredSubagentError,
} from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";

const workerAgent: AgentDefinition = {
	name: "task",
	description: "General worker",
	systemPrompt: "You are a worker.",
	source: "bundled",
};

function makeStubResult(options: executorModule.ExecutorOptions): SingleResult {
	return {
		index: options.index,
		id: options.id,
		agent: options.agent.name,
		agentSource: options.agent.source,
		task: options.task,
		assignment: options.assignment,
		exitCode: 0,
		output: `completed:${options.id}`,
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 10,
		requests: 1,
	};
}

describe("AGY 1.5.0 Swarm v2 Parity (Channels, Sharded Spawns, Workspace Modes & Transcript Forking)", () => {
	let registry: AgentRegistryApi;
	const received = new Map<string, IrcMessage[]>();
	const tempDirs: string[] = [];

	function registerPeer(id: string, status: "running" | "idle" = "running", sessionFile: string | null = null): void {
		const inbox: IrcMessage[] = [];
		received.set(id, inbox);
		registry.register({
			id,
			displayName: id,
			kind: "sub",
			parentId: "Main",
			status,
			sessionFile,
			session: {
				deliverIrcMessage: async (msg: IrcMessage) => {
					inbox.push(msg);
					return status === "idle" ? "woken" : "injected";
				},
			} as unknown as AgentSession,
		});
	}

	function createToolSession(
		overrides: {
			senderId?: string;
			cwd?: string;
			sessionFile?: string | null;
			artifactsDir?: string | null;
			planMode?: boolean;
			settings?: Record<string, unknown>;
		} = {},
	): ToolSession {
		return {
			cwd: overrides.cwd ?? "/tmp",
			hasUI: false,
			settings: Settings.isolated({
				"async.enabled": false,
				"task.batch": true,
				"task.isolation.enabled": false,
				...overrides.settings,
			}),
			getSessionFile: () => overrides.sessionFile ?? null,
			getArtifactsDir: () => overrides.artifactsDir ?? null,
			getSessionSpawns: () => "*",
			getAgentId: () => overrides.senderId ?? "Main",
			agentRegistry: registry,
			getPlanModeState: () => (overrides.planMode ? { enabled: true, planFilePath: "local://PLAN.md" } : undefined),
		} as unknown as ToolSession;
	}

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		registry = AgentRegistry.global();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null });
		received.clear();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		IrcBus.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		for (const dir of tempDirs.splice(0)) {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("routes scoped pub/sub messages via agent://channel/<topic>, persists feed to disk, and isolates unsubscribed peers", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-channel-board-"));
		tempDirs.push(tmpDir);
		const sessionFile = path.join(tmpDir, "root-session.jsonl");
		const artifactsDir = path.join(tmpDir, "root-session");
		await fs.mkdir(artifactsDir, { recursive: true });
		await Bun.write(sessionFile, "");

		registerPeer("Backend", "running");
		registerPeer("Frontend", "idle");
		registerPeer("Unrelated", "running");

		const backendWrite = new WriteTool(createToolSession({ senderId: "Backend", sessionFile, artifactsDir }));
		const frontendWrite = new WriteTool(createToolSession({ senderId: "Frontend", sessionFile, artifactsDir }));

		const subRes = await frontendWrite.execute("sub-1", {
			path: "agent://channel/api-contract?subscribe",
			content: "",
		});
		expect(subRes.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("Subscribed Frontend to #api-contract"),
		});

		const pubRes = await backendWrite.execute("pub-1", {
			path: "agent://channel/api-contract",
			content: "POST /v1/orders returns { orderId: string }",
		});
		expect(pubRes.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("Posted to #api-contract; delivered to 1 of 1 subscriber(s)."),
		});

		// Subscribed idle peer receives tagged message; sender and unsubscribed peer receive nothing
		expect(received.get("Frontend")?.map(m => [m.from, m.body])).toEqual([
			["Backend", "[#api-contract] POST /v1/orders returns { orderId: string }"],
		]);
		expect(received.get("Backend")).toEqual([]);
		expect(received.get("Unrelated")).toEqual([]);

		// Late-reading coordinator inspects channel directory and chronological feed via AgentProtocolHandler
		const handler = new AgentProtocolHandler();
		const listResource = await handler.resolve(new URL("agent://channel") as never, {
			sessionFile,
			agentRegistry: registry,
		});
		expect(listResource.content).toContain("#api-contract");
		expect(listResource.content).toContain("1 post(s)");

		const feedResource = await handler.resolve(new URL("agent://channel/api-contract") as never, {
			sessionFile,
			agentRegistry: registry,
		});
		expect(feedResource.content).toContain("# Channel #api-contract");
		expect(feedResource.content).toContain("Frontend, Backend");
		expect(feedResource.content).toContain("POST /v1/orders returns { orderId: string }");

		// Unsubscribing stops future deliveries while retaining feed history
		await frontendWrite.execute("unsub-1", {
			path: "agent://channel/api-contract?unsubscribe",
			content: "",
		});
		await backendWrite.execute("pub-2", {
			path: "agent://channel/api-contract",
			content: "Added status enum field",
		});
		expect(received.get("Frontend")).toHaveLength(1);

		// Path traversal & invalid channel names are rejected
		const rejected = backendWrite.execute("bad-1", { path: "agent://channel/..%2Fevil", content: "bad" });
		await expect(rejected).rejects.toThrow("Invalid channel topic");
	});

	it("expands shardTasks[] and count into <name>-1..<name>-N spawns and rejects collisions or mismatched counts", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [workerAgent],
			projectAgentsDir: null,
		});
		const captured: Array<{ index: number; id: string; assignment?: string }> = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			captured.push({ index: options.index, id: options.id, assignment: options.assignment });
			return makeStubResult(options);
		});

		const tool = await TaskTool.create(createToolSession());
		const result = await tool.execute("call-shard", {
			context: "# Goal\nAudit all 3 subsystems",
			tasks: [
				{
					name: "SliceAudit",
					agent: "task",
					task: "Inspect error boundaries.",
					solutionSpace: "bounded module audit",
					shardTasks: ["src/auth", "src/billing", "src/ledger"],
				},
				{
					name: "StressProbe",
					agent: "task",
					task: "Run concurrency probe.",
					solutionSpace: "bounded probe",
					count: 2,
				},
			],
		});

		expect(result.isError).not.toBe(true);
		captured.sort((a, b) => a.index - b.index);
		expect(captured.map(item => item.id)).toEqual([
			"SliceAudit-1",
			"SliceAudit-2",
			"SliceAudit-3",
			"StressProbe-1",
			"StressProbe-2",
		]);
		expect(captured[0]?.assignment).toContain("# Assigned Shard (1/3)\nsrc/auth");
		expect(captured[2]?.assignment).toContain("# Assigned Shard (3/3)\nsrc/ledger");
		expect(captured[3]?.assignment).toContain("Homogeneous worker replica 1 of 2.");

		// Mismatched count vs shardTasks.length fails validation cleanly
		const mismatch = await tool.execute("call-mismatch", {
			context: "# Goal\nX",
			tasks: [
				{
					name: "Bad",
					agent: "task",
					task: "Work",
					solutionSpace: "c",
					count: 2,
					shardTasks: ["only-one"],
				},
			],
		});
		expect(mismatch.isError).toBe(true);
		expect(mismatch.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("must match `shardTasks.length`"),
		});

		// Collision between expanded <name>-1 and explicit sibling name fails validation
		const collision = await tool.execute("call-collision", {
			context: "# Goal\nX",
			tasks: [
				{ name: "Worker", agent: "task", task: "A", solutionSpace: "c", count: 2 },
				{ name: "Worker-1", agent: "task", task: "B", solutionSpace: "c" },
			],
		});
		expect(collision.isError).toBe(true);
		expect(collision.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("Duplicate task name"),
		});
	});

	it("maps workspace='share' to patch isolation, workspace='branch' to branch isolation, and enforces planMode & enabled gates", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [workerAgent],
			projectAgentsDir: null,
		});

		const isoSession = createToolSession({ settings: { "task.isolation.enabled": true } });
		const sharePolicy = await resolveEffectiveSubagentPolicy({
			session: isoSession,
			invocationKind: "task",
			assignment: "Edit module A",
			agent: "task",
			isolation: { requested: true, merge: "patch" },
		});
		expect(sharePolicy.isIsolated).toBe(true);
		expect(sharePolicy.mergeMode).toBe("patch");

		const branchPolicy = await resolveEffectiveSubagentPolicy({
			session: isoSession,
			invocationKind: "task",
			assignment: "Edit module B",
			agent: "task",
			isolation: { requested: true, merge: "branch" },
		});
		expect(branchPolicy.isIsolated).toBe(true);
		expect(branchPolicy.mergeMode).toBe("branch");

		//TaskTool schema hides workspace in planMode and exposes it when isolation is enabled
		const enabledTool = await TaskTool.create(isoSession);
		const planTool = await TaskTool.create(
			createToolSession({ planMode: true, settings: { "task.isolation.enabled": true } }),
		);
		expect(enabledTool.description).toContain("`workspace`");
		expect(planTool.description).not.toContain("`workspace`");

		// Contradictory isolated + workspace flags are rejected before execution
		const contradiction = await enabledTool.execute("call-contradict", {
			context: "# Goal\nX",
			tasks: [
				{
					name: "Conflict",
					agent: "task",
					task: "Do work",
					solutionSpace: "c",
					isolated: false,
					workspace: "branch",
				},
			],
		});
		expect(contradiction.isError).toBe(true);
		expect(contradiction.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining('cannot combine `isolated: false` with `workspace: "branch"`'),
		});

		// Requesting workspace="share" when task.isolation.enabled is false fails preflight
		const disabledTool = await TaskTool.create(createToolSession({ settings: { "task.isolation.enabled": false } }));
		const gated = await disabledTool.execute("call-gated", {
			context: "# Goal\nX",
			tasks: [{ name: "IsoOff", agent: "task", task: "Do work", solutionSpace: "c", workspace: "share" }],
		});
		expect(gated.isError).toBe(true);
		expect(gated.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("task.isolation.enabled; it is currently false"),
		});
	});

	it("forks a sibling agent's persisted transcript via forkFrom while preserving worker capabilities and rejecting foreign trees", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fork-from-"));
		tempDirs.push(tmpDir);

		const rootFile = path.join(tmpDir, "root.jsonl");
		const artifactsDir = path.join(tmpDir, "root");
		await fs.mkdir(artifactsDir, { recursive: true });

		const rootManager = await SessionManager.open(rootFile, artifactsDir, undefined, { initialCwd: tmpDir });
		rootManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Root coordinator instructions" }],
			timestamp: Date.now(),
		});
		await rootManager.ensureOnDisk();
		await rootManager.flush();

		const siblingFile = path.join(artifactsDir, "Explorer1.jsonl");
		const siblingManager = await SessionManager.open(siblingFile, artifactsDir, undefined, {
			initialCwd: tmpDir,
			parentSession: rootFile,
			suppressBreadcrumb: true,
		});
		siblingManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Survey auth endpoints and token TTLs" }],
			timestamp: Date.now(),
		});
		await siblingManager.ensureOnDisk();
		await siblingManager.flush();

		registerPeer("Explorer1", "idle", siblingFile);

		const session = createToolSession({
			cwd: tmpDir,
			sessionFile: rootFile,
			artifactsDir,
		});

		const prepared = await prepareForkFromSession({
			session,
			forkFrom: "Explorer1",
			agent: workerAgent,
			planMode: false,
			hasSourceSession: false,
		});
		expect(prepared.sourceFile).toBe(siblingFile);
		expect(prepared.fromLabel).toBe("Explorer1");
		expect(prepared.promptSuffix("Reviser1")).toContain('from="Explorer1"');
		expect(prepared.promptSuffix("Reviser1")).toContain("Reviser1");

		// Forking via SessionManager.forkFrom carries Explorer1's message history into the new worker's file
		const childFile = path.join(artifactsDir, "Reviser1.jsonl");
		const forkedManager = await SessionManager.forkFrom(prepared.sourceFile, tmpDir, undefined, undefined, {
			copyArtifacts: false,
			suppressBreadcrumb: true,
			sessionFile: childFile,
			resetInheritedCost: true,
			repairInterruptedTail: true,
		});
		const inheritedTexts = forkedManager
			.getBranch()
			.flatMap(entry =>
				entry.type === "message" && "content" in entry.message && Array.isArray(entry.message.content)
					? entry.message.content
					: [],
			)
			.flatMap(block => (block.type === "text" ? [block.text] : []));
		expect(inheritedTexts).toContain("Survey auth endpoints and token TTLs");

		// Policy resolution keeps normal worker IRC & LSP enabled (unlike read-only seance) and normalizes channels
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [workerAgent],
			projectAgentsDir: null,
		});
		const policy = await resolveEffectiveSubagentPolicy({
			session,
			invocationKind: "task",
			assignment: "Implement token refresh fix",
			agent: "task",
			forkFrom: "Explorer1",
			channels: ["#M1-Contract"],
		});
		expect(policy.forkSession?.sourceFile).toBe(siblingFile);
		expect(policy.preparedSession).toBeUndefined();
		expect(policy.enableIrc).toBe(true);
		expect(policy.channels).toEqual(["m1-contract"]);

		// Foreign session transcript outside the current session tree is rejected
		const foreignDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-foreign-"));
		tempDirs.push(foreignDir);
		const foreignFile = path.join(foreignDir, "ForeignPeer.jsonl");
		const foreignManager = await SessionManager.open(foreignFile, foreignDir, undefined, { initialCwd: foreignDir });
		await foreignManager.ensureOnDisk();
		await foreignManager.flush();
		registerPeer("ForeignPeer", "idle", foreignFile);

		const foreignPolicyPromise = resolveEffectiveSubagentPolicy({
			session,
			invocationKind: "task",
			assignment: "Try foreign fork",
			agent: "task",
			forkFrom: "ForeignPeer",
		});
		await expect(foreignPolicyPromise).rejects.toThrow(StructuredSubagentError);

		// ChannelBoard.subscribeMany persists launch subscriptions cleanly
		await ChannelBoard.global().subscribeMany(policy.channels!, "Reviser1", artifactsDir);
		const feed = await ChannelBoard.global().readFeed("m1-contract", [artifactsDir]);
		expect(feed.subscribers).toContain("Reviser1");
	});
});
