import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { BUILTIN_AGY_COMPAT_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-agy-compat";
import type { SlashCommandRuntime, TuiSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { loadBundledAgents } from "@oh-my-pi/pi-coding-agent/task/agents";
import { getAgent } from "@oh-my-pi/pi-coding-agent/task/discovery";
import {
	resolveTeamworkForkModel,
	resolveTeamworkForkPreviewModel,
	runTeamworkForkAcp,
	runTeamworkForkPreviewAcp,
	runTeamworkForkPreviewTui,
	runTeamworkForkTui,
} from "@oh-my-pi/pi-coding-agent/task/teamwork-fork";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";
import { cfgTaskAgentModelOverrides } from "@oh-my-pi/pi-coding-agent/task/settings";
function userMsg(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

function assistantMsg(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

function createTestModel(id = "test-model") {
	return buildModel({
		id,
		name: "Test Model",
		provider: "test-provider",
		api: "openai-responses",
		baseUrl: "https://example.com/api",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	});
}
describe("Teamwork Fork: Context Inheritance & Full Default Model", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "teamwork-fork-test-"));
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("bundles teamwork-fork agent definition with full capabilities and @default model", () => {
		const agents = loadBundledAgents();
		const forkAgent = agents.find(a => a.name === "teamwork-fork");

		expect(forkAgent).toBeDefined();
		expect(forkAgent?.name).toBe("teamwork-fork");
		expect(forkAgent?.description).toContain("full default model");
		expect(forkAgent?.model).toEqual(["@default"]);
		expect(forkAgent?.spawns).toBe("*");
		const tools = forkAgent?.tools ?? [];
		expect(tools).toContain("edit");
		expect(tools).toContain("write");
		expect(tools).toContain("read");
		expect(tools).toContain("bash");
		expect(tools).toContain("hub");
	});

	it("resolves all teamwork-fork aliases correctly", () => {
		const agents = loadBundledAgents();

		expect(getAgent(agents, "teamwork-fork")?.name).toBe("teamwork-fork");
		expect(getAgent(agents, "teamwork_preview_fork")?.name).toBe("teamwork-fork");
		expect(getAgent(agents, "teamwork-preview-fork")?.name).toBe("teamwork-fork");
		expect(getAgent(agents, "tw-fork")?.name).toBe("teamwork-fork");
		expect(getAgent(agents, "fork")?.name).toBe("teamwork-fork");
	});

	it("registers /teamwork-fork slash command and subcommands in BUILTIN_AGY_COMPAT_SLASH_COMMANDS", () => {
		const forkCmd = BUILTIN_AGY_COMPAT_SLASH_COMMANDS.find(c => c.name === "teamwork-fork");
		expect(forkCmd).toBeDefined();
		expect(forkCmd?.aliases).toContain("tw-fork");
		expect(forkCmd?.description).toContain("full default model");

		const teamworkCmd = BUILTIN_AGY_COMPAT_SLASH_COMMANDS.find(c => c.name === "teamwork-preview");
		expect(teamworkCmd).toBeDefined();
		const forkSubcommand = teamworkCmd?.subcommands?.find(s => s.name === "fork");
		expect(forkSubcommand).toBeDefined();
		expect(forkSubcommand?.description).toContain("full default model");
	});

	it("resolves active session model or default role model, ignoring agentModelOverrides", () => {
		const dummyModel = createTestModel("gpt-test-model");

		// 1. Session with active model
		const mockSessionWithModel = {
			model: dummyModel,
			configuredThinkingLevel: () => ThinkingLevel.High,
		} as unknown as AgentSession;

		const res1 = resolveTeamworkForkModel(mockSessionWithModel);
		expect(res1.model?.id).toBe("gpt-test-model");
		expect(res1.thinkingLevel).toBe(ThinkingLevel.High);

		// 2. Session without active model, falling back to default role
		const mockSessionWithoutModel = {
			model: undefined,
			configuredThinkingLevel: () => undefined,
			resolveRoleModelWithThinking: (role: string) => {
				if (role === "default") {
					return { model: dummyModel, thinkingLevel: ThinkingLevel.Medium };
				}
				return { model: undefined, thinkingLevel: undefined };
			},
		} as unknown as AgentSession;

		const res2 = resolveTeamworkForkModel(mockSessionWithoutModel);
		expect(res2.model?.id).toBe("gpt-test-model");
		expect(res2.thinkingLevel).toBe(ThinkingLevel.Medium);
	});

	it("handles /teamwork-fork in ACP mode when session is not yet persisted", async () => {
		const outputs: string[] = [];
		const dummyModel = createTestModel("default-model");

		const mockSession = {
			model: dummyModel,
			configuredThinkingLevel: () => undefined,
		} as unknown as AgentSession;

		const mockSessionManager = {
			getSessionFile: () => null,
		} as unknown as SessionManager;

		const mockRuntime: SlashCommandRuntime = {
			cwd: tempDir,
			session: mockSession,
			sessionManager: mockSessionManager,
			settings: {} as unknown as Settings,
			output: (text: string) => {
				outputs.push(text);
			},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		};

		// Empty args -> show usage
		const emptyResult = await runTeamworkForkAcp(mockRuntime, "");
		expect(emptyResult).toEqual({ consumed: true });
		expect(outputs[0]).toContain("Usage: /teamwork-fork");

		// Non-empty args -> returns TEAMWORK_FORK prompt
		const result = await runTeamworkForkAcp(mockRuntime, "verify user authentication logic");
		expect(result).toBeDefined();
		if (result && "prompt" in result) {
			expect(result.prompt).toContain("<TEAMWORK_FORK>");
			expect(result.prompt).toContain("verify user authentication logic");
			expect(result.prompt).toContain("full default model");
		} else {
			throw new Error("Expected prompt result");
		}
	});

	it("handles /teamwork-fork-preview in ACP mode when session is not yet persisted", async () => {
		const outputs: string[] = [];
		const dummyModel = createTestModel("default-model");

		const mockSession = {
			model: dummyModel,
			configuredThinkingLevel: () => undefined,
		} as unknown as AgentSession;

		const mockSessionManager = {
			getSessionFile: () => null,
		} as unknown as SessionManager;

		const mockRuntime: SlashCommandRuntime = {
			cwd: tempDir,
			session: mockSession,
			sessionManager: mockSessionManager,
			settings: {} as unknown as Settings,
			output: (text: string) => {
				outputs.push(text);
			},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		};

		// Empty args -> show usage
		const emptyResult = await runTeamworkForkPreviewAcp(mockRuntime, "");
		expect(emptyResult).toEqual({ consumed: true });
		expect(outputs[0]).toContain("Usage: /teamwork-fork-preview");

		// Non-empty args -> returns TEAMWORK_FORK_PREVIEW prompt
		const result = await runTeamworkForkPreviewAcp(mockRuntime, "verify user authentication logic");
		expect(result).toBeDefined();
		if (result && "prompt" in result) {
			expect(result.prompt).toContain("<TEAMWORK_FORK_PREVIEW>");
			expect(result.prompt).toContain("verify user authentication logic");
			expect(result.prompt).toContain("model configured in /agents");
		} else {
			throw new Error("Expected prompt result");
		}
	});

	it("handles /teamwork-fork in TUI mode with status notifications on validation", async () => {
		const statuses: string[] = [];
		const errors: string[] = [];
		const dummyModel = createTestModel("default-model");

		let currentAsyncJobManager: AsyncJobManager | null = null;
		const mockSession = {
			model: dummyModel,
			configuredThinkingLevel: () => undefined,
			get asyncJobManager() {
				return currentAsyncJobManager;
			},
		} as unknown as AgentSession;

		const mockSessionManager = {
			getSessionFile: () => null,
			getCwd: () => tempDir,
		} as unknown as SessionManager;

		const mockCtx: Partial<InteractiveModeContext> = {
			showStatus: (msg: string) => {
				statuses.push(msg);
			},
			showError: (err: string) => {
				errors.push(err);
			},
			session: mockSession,
			sessionManager: mockSessionManager,
			settings: {} as unknown as Settings,
		};

		// 1. Empty input
		await runTeamworkForkTui(mockCtx as InteractiveModeContext, "");
		expect(statuses).toContain("Usage: /teamwork-fork <task>");

		// 2. Missing async jobs manager
		await runTeamworkForkTui(mockCtx as InteractiveModeContext, "run benchmark");
		expect(errors[0]).toContain("Background jobs are disabled");

		// 3. Enable async manager, but missing persisted session file
		currentAsyncJobManager = { register: () => "job-1" } as unknown as AsyncJobManager;
		await runTeamworkForkTui(mockCtx as InteractiveModeContext, "run benchmark");
		expect(errors[1]).toContain("/teamwork-fork requires a persisted session");
	});

	it("executes /teamwork fork subcommand in both ACP and TUI handlers", async () => {
		const cmd = BUILTIN_AGY_COMPAT_SLASH_COMMANDS.find(c => c.name === "teamwork-preview");
		expect(cmd).toBeDefined();

		const dummyModel = createTestModel("default-model");

		const mockSession = {
			model: dummyModel,
			configuredThinkingLevel: () => undefined,
			asyncJobManager: null,
		} as unknown as AgentSession;

		const mockSessionManager = {
			getSessionFile: () => null,
			getCwd: () => tempDir,
		} as unknown as SessionManager;

		// Test ACP handle with subcommand "fork"
		const acpResult = await cmd!.handle!(
			{
				name: "teamwork",
				args: "fork inspect security invariants",
				text: "teamwork fork inspect security invariants",
			},
			{
				cwd: tempDir,
				session: mockSession,
				sessionManager: mockSessionManager,
				settings: {} as unknown as Settings,
				output: () => {},
				refreshCommands: () => {},
				reloadPlugins: async () => {},
			},
		);

		expect(acpResult).toBeDefined();
		if (acpResult && "prompt" in acpResult) {
			expect(acpResult.prompt).toContain("<TEAMWORK_FORK>");
			expect(acpResult.prompt).toContain("inspect security invariants");
		} else {
			throw new Error("Expected prompt result");
		}

		// Test TUI handleTui with subcommand "fork" (interactive prompt like /teamwork-preview)
		const tuiResult = await cmd!.handleTui!(
			{ name: "teamwork", args: "fork do something", text: "teamwork fork do something" },
			{
				ctx: {
					editor: { setText: () => {} },
					showError: () => {},
					showStatus: () => {},
					session: mockSession,
					sessionManager: mockSessionManager,
					settings: {} as unknown as Settings,
					switchSessionModel: async () => {},
				} as unknown as InteractiveModeContext,
			} as unknown as TuiSlashCommandRuntime,
		);

		expect(tuiResult).toBeDefined();
		if (tuiResult && "prompt" in tuiResult) {
			expect(tuiResult.prompt).toContain("<TEAMWORK_FORK>");
			expect(tuiResult.prompt).toContain("do something");
		} else {
			throw new Error("Expected prompt result in interactive TUI mode");
		}

		// Test TUI handleTui with subcommand "fork --bg" (background mode)
		const errors: string[] = [];
		const tuiBgResult = await cmd!.handleTui!(
			{ name: "teamwork", args: "fork --bg do something", text: "teamwork fork --bg do something" },
			{
				ctx: {
					editor: { setText: () => {} },
					showError: (err: string) => errors.push(err),
					showStatus: () => {},
					session: mockSession,
					sessionManager: mockSessionManager,
					settings: {} as unknown as Settings,
					switchSessionModel: async () => {},
					handleTeamworkForkCommand: async (work: string) => {
						await runTeamworkForkTui(
							{
								showError: (err: string) => errors.push(err),
								showStatus: () => {},
								session: mockSession,
								sessionManager: mockSessionManager,
								settings: {} as unknown as Settings,
							} as unknown as InteractiveModeContext,
							work,
						);
					},
				} as unknown as InteractiveModeContext,
			} as unknown as TuiSlashCommandRuntime,
		);
		expect(tuiBgResult).toEqual({ consumed: true });
		expect(errors[0]).toContain("Background jobs are disabled");
	});
	it("executes /teamwork-fork slash command in both ACP and TUI handlers", async () => {
		const cmd = BUILTIN_AGY_COMPAT_SLASH_COMMANDS.find(c => c.name === "teamwork-fork");
		expect(cmd).toBeDefined();

		const dummyModel = createTestModel("default-model");

		const mockSession = {
			model: dummyModel,
			configuredThinkingLevel: () => undefined,
			asyncJobManager: null,
		} as unknown as AgentSession;

		const mockSessionManager = {
			getSessionFile: () => null,
			getCwd: () => tempDir,
		} as unknown as SessionManager;

		// Test ACP handle
		const acpResult = await cmd!.handle!(
			{ name: "teamwork-fork", args: "implement oauth login", text: "/teamwork-fork implement oauth login" },
			{
				cwd: tempDir,
				session: mockSession,
				sessionManager: mockSessionManager,
				settings: {} as unknown as Settings,
				output: () => {},
				refreshCommands: () => {},
				reloadPlugins: async () => {},
			},
		);

		expect(acpResult).toBeDefined();
		if (acpResult && "prompt" in acpResult) {
			expect(acpResult.prompt).toContain("<TEAMWORK_FORK>");
			expect(acpResult.prompt).toContain("implement oauth login");
		} else {
			throw new Error("Expected prompt result");
		}

		// Test TUI handleTui default interactive mode
		const tuiResult = await cmd!.handleTui!(
			{ name: "teamwork-fork", args: "implement oauth login", text: "/teamwork-fork implement oauth login" },
			{
				ctx: {
					editor: { setText: () => {} },
					showError: () => {},
					showStatus: () => {},
					session: mockSession,
					sessionManager: mockSessionManager,
					settings: {} as unknown as Settings,
					switchSessionModel: async () => {},
				} as unknown as InteractiveModeContext,
			} as unknown as TuiSlashCommandRuntime,
		);
		expect(tuiResult).toBeDefined();
		if (tuiResult && "prompt" in tuiResult) {
			expect(tuiResult.prompt).toContain("<TEAMWORK_FORK>");
			expect(tuiResult.prompt).toContain("implement oauth login");
		} else {
			throw new Error("Expected prompt result in interactive TUI mode");
		}

		// Test TUI handleTui with --bg
		const errors: string[] = [];
		const tuiBgResult = await cmd!.handleTui!(
			{
				name: "teamwork-fork",
				args: "--bg implement oauth login",
				text: "/teamwork-fork --bg implement oauth login",
			},
			{
				ctx: {
					editor: { setText: () => {} },
					showError: (err: string) => errors.push(err),
					showStatus: () => {},
					session: mockSession,
					sessionManager: mockSessionManager,
					settings: {} as unknown as Settings,
					switchSessionModel: async () => {},
					handleTeamworkForkCommand: async (work: string) => {
						await runTeamworkForkTui(
							{
								showError: (err: string) => errors.push(err),
								showStatus: () => {},
								session: mockSession,
								sessionManager: mockSessionManager,
								settings: {} as unknown as Settings,
							} as unknown as InteractiveModeContext,
							work,
						);
					},
				} as unknown as InteractiveModeContext,
			} as unknown as TuiSlashCommandRuntime,
		);
		expect(tuiBgResult).toEqual({ consumed: true });
		expect(errors[0]).toContain("Background jobs are disabled");
	});
	it("forks 100% conversation context on disk and clears task.agentModelOverrides", async () => {
		const parentManager = SessionManager.create(tempDir, tempDir);
		parentManager.appendMessage(userMsg("Secret token: FORK_INHERITANCE_VERIFIED_12345"));
		parentManager.appendMessage(assistantMsg("Acknowledged secret token."));
		await parentManager.ensureOnDisk();
		await parentManager.flush();

		const parentFile = parentManager.getSessionFile();
		expect(parentFile).toBeDefined();

		const cloneFile = path.join(tempDir, "TeamworkFork-Clone.jsonl");
		const forkedManager = await SessionManager.forkFrom(parentFile!, tempDir, tempDir, undefined, {
			copyArtifacts: false,
			suppressBreadcrumb: true,
			sessionFile: cloneFile,
			resetInheritedCost: true,
			repairInterruptedTail: true,
		});

		// Verify the clone session exists on disk
		const fileExists = await fs
			.stat(cloneFile)
			.then(() => true)
			.catch(() => false);
		expect(fileExists).toBe(true);

		// Verify 100% context inheritance
		const entries = forkedManager.getEntries();
		const messageEntries = entries.filter(e => e.type === "message");
		expect(messageEntries.length).toBeGreaterThanOrEqual(2);

		const foundUserMsg = messageEntries.find(
			e =>
				e.type === "message" &&
				e.message &&
				typeof e.message === "object" &&
				"role" in e.message &&
				e.message.role === "user",
		);
		expect(JSON.stringify(foundUserMsg)).toContain("FORK_INHERITANCE_VERIFIED_12345");

		// Verify settings clear task.agentModelOverrides
		const baseSettings = Settings.isolated({
			"task.agentModelOverrides": {
				"teamwork-fork": "some-cheap-model",
				"teamwork-worker": "worker-model",
			},
		});
		const subSettings = createSubagentSettings(baseSettings, {
			"task.agentModelOverrides": {
				"teamwork-fork": "",
			},
		});
		const overrides = cfgTaskAgentModelOverrides.get(subSettings);
		expect(overrides["teamwork-fork"]).toBe("");
	});

	it("bundles teamwork-fork-preview agent definition and resolves all aliases", () => {
		const agents = loadBundledAgents();
		const previewAgent = agents.find(a => a.name === "teamwork-fork-preview");

		expect(previewAgent).toBeDefined();
		expect(previewAgent?.name).toBe("teamwork-fork-preview");
		expect(previewAgent?.description).toContain("/agents");
		expect(previewAgent?.spawns).toBe("*");
		const tools = previewAgent?.tools ?? [];
		expect(tools).toContain("edit");
		expect(tools).toContain("write");
		expect(tools).toContain("read");
		expect(tools).toContain("bash");
		expect(tools).toContain("hub");

		// Verify all aliases
		expect(getAgent(agents, "teamwork-fork-preview")?.name).toBe("teamwork-fork-preview");
		expect(getAgent(agents, "teamwork-preview-fork-preview")?.name).toBe("teamwork-fork-preview");
		expect(getAgent(agents, "teamwork_fork_preview")?.name).toBe("teamwork-fork-preview");
		expect(getAgent(agents, "teamwork_preview_fork_preview")?.name).toBe("teamwork-fork-preview");
		expect(getAgent(agents, "tw-fork-preview")?.name).toBe("teamwork-fork-preview");
		expect(getAgent(agents, "fork-preview")?.name).toBe("teamwork-fork-preview");
	});

	it("registers /teamwork-fork-preview and fork-preview subcommand", () => {
		const forkPreviewCmd = BUILTIN_AGY_COMPAT_SLASH_COMMANDS.find(c => c.name === "teamwork-fork-preview");
		expect(forkPreviewCmd).toBeDefined();
		expect(forkPreviewCmd?.aliases).toContain("tw-fork-preview");
		expect(forkPreviewCmd?.description).toContain("/agents");

		const teamworkCmd = BUILTIN_AGY_COMPAT_SLASH_COMMANDS.find(c => c.name === "teamwork-preview");
		expect(teamworkCmd).toBeDefined();
		const forkPreviewSubcommand = teamworkCmd?.subcommands?.find(s => s.name === "fork-preview");
		expect(forkPreviewSubcommand).toBeDefined();
		expect(forkPreviewSubcommand?.description).toContain("/agents");
	});

	it("resolves model according to /agents (task.agentModelOverrides) in resolveTeamworkForkPreviewModel", () => {
		const defaultModel = createTestModel("default-model");
		const customPreviewModel = createTestModel("custom-agents-preview-model");

		// 1. Session with override in settings for teamwork-fork-preview
		const settingsWithOverride = Settings.isolated({
			"task.agentModelOverrides": {
				"teamwork-fork-preview": "custom-agents-preview-model",
			},
		});

		const mockModelRegistry = {
			getAvailable: () => [defaultModel, customPreviewModel],
			find: (id: string) => (id === "custom-agents-preview-model" ? customPreviewModel : defaultModel),
		};

		const mockSessionWithOverride = {
			model: defaultModel,
			settings: settingsWithOverride,
			modelRegistry: mockModelRegistry,
			configuredThinkingLevel: () => ThinkingLevel.Low,
		} as unknown as AgentSession;

		const resOverride = resolveTeamworkForkPreviewModel(mockSessionWithOverride);
		expect(resOverride.model?.id).toBe("custom-agents-preview-model");

		// 2. Session with NO override -> falls back to session model
		const settingsWithoutOverride = Settings.isolated({
			"task.agentModelOverrides": {},
		});
		const mockSessionWithoutOverride = {
			model: defaultModel,
			settings: settingsWithoutOverride,
			modelRegistry: mockModelRegistry,
			configuredThinkingLevel: () => ThinkingLevel.Low,
		} as unknown as AgentSession;

		const resFallback = resolveTeamworkForkPreviewModel(mockSessionWithoutOverride);
		expect(resFallback.model?.id).toBe("default-model");
	});

	it("executes /teamwork-fork-preview and /teamwork fork-preview in ACP and TUI handlers", async () => {
		const previewCmd = BUILTIN_AGY_COMPAT_SLASH_COMMANDS.find(c => c.name === "teamwork-fork-preview");
		expect(previewCmd).toBeDefined();

		const teamworkCmd = BUILTIN_AGY_COMPAT_SLASH_COMMANDS.find(c => c.name === "teamwork-preview");
		expect(teamworkCmd).toBeDefined();

		const dummyModel = createTestModel("agents-configured-model");
		const mockSession = {
			model: dummyModel,
			configuredThinkingLevel: () => undefined,
			asyncJobManager: null,
		} as unknown as AgentSession;

		const mockSessionManager = {
			getSessionFile: () => null,
			getCwd: () => tempDir,
		} as unknown as SessionManager;

		// 1. Standalone ACP handler
		const acpResult = await previewCmd!.handle!(
			{
				name: "teamwork-fork-preview",
				args: "benchmark performance",
				text: "/teamwork-fork-preview benchmark performance",
			},
			{
				cwd: tempDir,
				session: mockSession,
				sessionManager: mockSessionManager,
				settings: {} as unknown as Settings,
				output: () => {},
				refreshCommands: () => {},
				reloadPlugins: async () => {},
			},
		);
		expect(acpResult).toBeDefined();
		if (acpResult && "prompt" in acpResult) {
			expect(acpResult.prompt).toContain("<TEAMWORK_FORK_PREVIEW>");
			expect(acpResult.prompt).toContain("benchmark performance");
		} else {
			throw new Error("Expected prompt result");
		}

		// 2. Subcommand ACP handler
		const subcommandAcpResult = await teamworkCmd!.handle!(
			{ name: "teamwork", args: "fork-preview audit security", text: "teamwork fork-preview audit security" },
			{
				cwd: tempDir,
				session: mockSession,
				sessionManager: mockSessionManager,
				settings: {} as unknown as Settings,
				output: () => {},
				refreshCommands: () => {},
				reloadPlugins: async () => {},
			},
		);
		expect(subcommandAcpResult).toBeDefined();
		if (subcommandAcpResult && "prompt" in subcommandAcpResult) {
			expect(subcommandAcpResult.prompt).toContain("<TEAMWORK_FORK_PREVIEW>");
			expect(subcommandAcpResult.prompt).toContain("audit security");
		} else {
			throw new Error("Expected prompt result");
		}

		// 3. TUI handlers (interactive mode like /teamwork-preview)
		const previewTuiResult = await previewCmd!.handleTui!(
			{ name: "teamwork-fork-preview", args: "benchmark", text: "/teamwork-fork-preview benchmark" },
			{
				ctx: {
					editor: { setText: () => {} },
					showError: () => {},
					showStatus: () => {},
					session: mockSession,
					sessionManager: mockSessionManager,
					settings: {} as unknown as Settings,
					switchSessionModel: async () => {},
				} as unknown as InteractiveModeContext,
			} as unknown as TuiSlashCommandRuntime,
		);
		expect(previewTuiResult).toBeDefined();
		if (previewTuiResult && "prompt" in previewTuiResult) {
			expect(previewTuiResult.prompt).toContain("<TEAMWORK_FORK_PREVIEW>");
			expect(previewTuiResult.prompt).toContain("benchmark");
		} else {
			throw new Error("Expected prompt result in interactive TUI mode");
		}

		// 4. TUI handlers with --bg (background mode)
		const errors: string[] = [];
		const mockCtx = {
			editor: { setText: () => {} },
			showError: (err: string) => errors.push(err),
			showStatus: () => {},
			session: mockSession,
			sessionManager: mockSessionManager,
			settings: {} as unknown as Settings,
			switchSessionModel: async () => {},
			handleTeamworkForkPreviewCommand: async (work: string) => {
				await runTeamworkForkPreviewTui(
					{
						showError: (err: string) => errors.push(err),
						showStatus: () => {},
						session: mockSession,
						sessionManager: mockSessionManager,
						settings: {} as unknown as Settings,
					} as unknown as InteractiveModeContext,
					work,
				);
			},
		} as unknown as InteractiveModeContext;

		await previewCmd!.handleTui!(
			{ name: "teamwork-fork-preview", args: "--bg benchmark", text: "/teamwork-fork-preview --bg benchmark" },
			{ ctx: mockCtx } as unknown as TuiSlashCommandRuntime,
		);
		expect(errors[0]).toContain("Background jobs are disabled");

		await teamworkCmd!.handleTui!(
			{ name: "teamwork", args: "fork-preview --bg benchmark", text: "teamwork fork-preview --bg benchmark" },
			{ ctx: mockCtx } as unknown as TuiSlashCommandRuntime,
		);
		expect(errors[1]).toContain("Background jobs are disabled");
	});
});
