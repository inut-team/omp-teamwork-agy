import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import {
	BUILTIN_AGY_COMPAT_SLASH_COMMANDS,
	expandAgyCompatSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-agy-compat";
import {
	checkChannelMentions,
	mentionsIn,
	mentionsMember,
	PostMessageTool,
	ReadBoardTool,
	SwarmRuntime,
	SwarmTool,
	SwarmWaitTool,
	validateChannelName,
	validateWorkerName,
} from "@oh-my-pi/pi-coding-agent/swarm";
import { loadBundledAgents } from "@oh-my-pi/pi-coding-agent/task/agents";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

function makeToolSession(options: {
	cwd: string;
	artifactsDir: string;
	agentId: string;
	taskDepth: number;
	registry: AgentRegistry;
	activeModel?: string;
}): ToolSession {
	const activeTools = new Set<string>(["read", "write"]);
	return {
		cwd: options.cwd,
		hasUI: false,
		settings: Settings.isolated({}),
		taskDepth: options.taskDepth,
		agentRegistry: options.registry,
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
		isToolActive: name => activeTools.has(name),
		setActiveToolNames: names => {
			activeTools.clear();
			for (const n of names) activeTools.add(n);
		},
	};
}

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(c => c.type === "text")?.text ?? "";
}

describe("Native Swarm (Antigravity v1.5.5 parity)", () => {
	let tmpDir = "";
	let artifactsDir = "";
	let registry: AgentRegistry;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-swarm-"));
		artifactsDir = path.join(tmpDir, "artifacts");
		await fs.mkdir(artifactsDir, { recursive: true });
		SwarmRuntime.resetForTests();
		registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: "Main",
			kind: "main",
			session: null,
			status: "idle",
		});
	});

	afterEach(async () => {
		SwarmRuntime.resetForTests();
		if (tmpDir) {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	it("ships bundled swarm-worker, swarm-monitor, and swarm-narrator agents", () => {
		const byName = new Map(loadBundledAgents().map(agent => [agent.name, agent]));
		expect(byName.get("swarm-worker")?.tools).toEqual(
			expect.arrayContaining(["swarm", "post_message", "read_board", "swarm_wait"]),
		);
		expect(byName.get("swarm-monitor")?.tools).toEqual(
			expect.arrayContaining(["read_board", "post_message", "swarm_wait", "swarm"]),
		);
		expect(byName.get("swarm-narrator")?.tools).toEqual(expect.arrayContaining(["read_board", "swarm_wait"]));
		expect(byName.get("swarm-narrator")?.tools).not.toContain("post_message");
	});

	it("enforces Agy 1.5.5 roster naming, channel naming, numbered prefixes, and @#channel rules", () => {
		expect(() => validateWorkerName("all")).toThrow(/broadcast token/);
		expect(() => validateWorkerName("coordinator")).toThrow(/root conversation/);
		expect(() => validateWorkerName("coordinator-2")).toThrow(/reserved for coordinators/);
		expect(() => validateWorkerName("Bad Name")).toThrow(/lowercase letters/);
		expect(validateWorkerName("parser-2")).toBe("parser-2");

		expect(() => validateChannelName("main")).toThrow(/reserved/);
		expect(() => validateChannelName("all")).toThrow(/reserved/);
		expect(() => validateChannelName("here")).toThrow(/reserved/);
		expect(validateChannelName("#parser-core")).toBe("parser-core");

		// Group prefix doorbell: @reviewer wakes reviewer-1 and reviewer-2; @reviewer-2 wakes only reviewer-2
		expect(mentionsMember("@reviewer check #4", "reviewer-1")).toBe(true);
		expect(mentionsMember("@reviewer check #4", "reviewer-2")).toBe(true);
		expect(mentionsMember("@reviewer-2 check #4", "reviewer-2")).toBe(true);
		expect(mentionsMember("@reviewer-2 check #4", "reviewer-1")).toBe(false);

		// @#main is rejected; @#parser calls active channel subscribers only
		expect(() => checkChannelMentions("hello @#main", () => ({ exists: true, archived: false }))).toThrow(
			"`@#main` is everyone; write `@all`",
		);

		const warnings = checkChannelMentions("ping @#legacy and @#missing", ch =>
			ch === "legacy" ? { exists: true, archived: true } : { exists: false, archived: false },
		);
		expect(warnings).toEqual([
			"`@#legacy` addressed nobody (archived channel)",
			"`@#missing` addressed nobody (unknown channel)",
		]);

		expect(mentionsIn("@#parser AST ready?", "lexer", ["main", "parser"], ch => ch === "parser")).toBe(true);
		expect(mentionsIn("@#parser AST ready?", "ui-worker", ["main", "ui"], ch => ch === "parser")).toBe(false);
	});

	it("isolates channel visibility while letting coordinator/narrator/monitor see all channels and cross-channel @mentions", async () => {
		const coordSession = makeToolSession({
			cwd: tmpDir,
			artifactsDir,
			agentId: MAIN_AGENT_ID,
			taskDepth: 0,
			registry,
		});
		const runtime = SwarmRuntime.forSession(coordSession);
		await runtime.ensureCoordinatorSwarm(coordSession, "Parser & UI Rewrite");

		await runtime.store.executeChannelOp({
			actor: "coordinator",
			op: "create",
			channel: "parser",
			topic: "AST work",
		});
		await runtime.store.executeChannelOp({ actor: "coordinator", op: "create", channel: "ui", topic: "Frontend" });

		await runtime.store.addMembersWithBrief({
			actor: "coordinator",
			briefText: "@parser-dev own parser",
			briefChannel: "parser",
			newMembers: [
				{
					name: "parser-dev",
					agent_id: "parser-dev",
					conversation_id: "parser-dev",
					role: "worker",
					added_by: "coordinator",
					model: "apphub/ag/gemini-4-carbon-400k",
					workspace: "share",
					channels: ["parser"],
					wake_mode: "mentions",
					killed: false,
				},
				{
					name: "ui-dev",
					agent_id: "ui-dev",
					conversation_id: "ui-dev",
					role: "worker",
					added_by: "coordinator",
					model: "apphub/ag/gemini-4-carbon-400k",
					workspace: "share",
					channels: ["ui"],
					wake_mode: "mentions",
					killed: false,
				},
				{
					name: "narrator",
					agent_id: "narrator",
					conversation_id: "narrator",
					role: "narrator",
					added_by: "coordinator",
					model: "apphub/ag/gemini-4-carbon-400k",
					workspace: "inherit",
					channels: null,
					wake_mode: "anything",
					killed: false,
				},
			],
		});

		const parserSession = makeToolSession({
			cwd: tmpDir,
			artifactsDir,
			agentId: "parser-dev",
			taskDepth: 1,
			registry,
		});
		const uiSession = makeToolSession({
			cwd: tmpDir,
			artifactsDir,
			agentId: "ui-dev",
			taskDepth: 1,
			registry,
		});
		const narratorSession = makeToolSession({
			cwd: tmpDir,
			artifactsDir,
			agentId: "narrator",
			taskDepth: 1,
			registry,
		});

		const parserPost = new PostMessageTool(parserSession);
		const uiPost = new PostMessageTool(uiSession);
		const narratorPost = new PostMessageTool(narratorSession);

		// Narrator is forbidden from posting to the board
		const narratorAttempt = await narratorPost.execute("c1", { text: "hello" });
		expect(narratorAttempt.isError).toBe(true);
		expect(firstText(narratorAttempt)).toContain("narrator never posts to the board");

		// parser-dev posts to its default home channel (#parser) without naming ui-dev
		const p1 = await parserPost.execute("c2", { text: "AST node layout updated" });
		expect(p1.isError).toBeUndefined();
		expect(firstText(p1)).toContain("in #parser");

		// ui-dev does NOT see #parser chatter in its default view
		const uiRead = new ReadBoardTool(uiSession);
		const uiRes1 = await uiRead.execute("c3", { since: 3 });
		expect(firstText(uiRes1)).toContain("0 new messages");

		// Cross-channel @ui-dev mention inside #parser DOES reach ui-dev!
		await parserPost.execute("c4", { text: "@ui-dev exported TokenSpan in ast.ts (#4)" });
		const uiRes2 = await uiRead.execute("c5", { since: 3 });
		expect(firstText(uiRes2)).toContain("@ui-dev exported TokenSpan");

		// Narrator sees every channel (#main, #parser, #ui)
		await uiPost.execute("c6", { text: "Rendered TokenSpan in component" });
		const narratorRead = new ReadBoardTool(narratorSession);
		const narRes = await narratorRead.execute("c7", { since: 0, limit: 50 });
		expect(firstText(narRes)).toContain("AST node layout updated");
		expect(firstText(narRes)).toContain("Rendered TokenSpan in component");

		// Exact `seqs` lookup fetches #4 without advancing cursor past #6
		const parserRead = new ReadBoardTool(parserSession);
		const seqLookup = await parserRead.execute("c8", { seqs: [4] });
		expect(firstText(seqLookup)).toContain("#4 @parser-dev");
		expect(firstText(seqLookup)).not.toContain("Rendered TokenSpan");

		// Archiving #parser blocks new posts while keeping history readable
		const swarmTool = new SwarmTool(coordSession);
		const archiveRes = await swarmTool.execute("c9", { action: "channel", op: "archive", channel: "parser" });
		expect(firstText(archiveRes)).toContain("Archived #parser");
		const postArchived = await parserPost.execute("c10", { channel: "parser", text: "late post" });
		expect(postArchived.isError).toBe(true);
		const historyRead = await parserRead.execute("c11", { channel: "parser", since: 0 });
		expect(firstText(historyRead)).toContain("AST node layout updated");
	});

	it("wakes swarm_wait immediately on missed messages (WaitCheck) and rings sleeping waiters on @mention / model switch", async () => {
		const coordSession = makeToolSession({
			cwd: tmpDir,
			artifactsDir,
			agentId: MAIN_AGENT_ID,
			taskDepth: 0,
			registry,
		});
		const runtime = SwarmRuntime.forSession(coordSession);
		await runtime.ensureCoordinatorSwarm(coordSession, "Wake Engine Test");
		await runtime.store.addMembersWithBrief({
			actor: "coordinator",
			briefText: "@verifier wait for diffs",
			briefChannel: "main",
			newMembers: [
				{
					name: "author",
					agent_id: "author",
					conversation_id: "author",
					role: "worker",
					added_by: "coordinator",
					model: "apphub/ag/gemini-4-carbon-400k",
					workspace: "inherit",
					channels: null,
					wake_mode: "mentions",
					killed: false,
				},
				{
					name: "verifier",
					agent_id: "author.verifier",
					conversation_id: "author.verifier",
					role: "worker",
					added_by: "author",
					model: "apphub/ag/gemini-4-carbon-400k",
					workspace: "inherit",
					channels: null,
					wake_mode: "mentions",
					killed: false,
				},
			],
		});

		const authorSession = makeToolSession({
			cwd: tmpDir,
			artifactsDir,
			agentId: "author",
			taskDepth: 1,
			registry,
		});
		const verifierSession = makeToolSession({
			cwd: tmpDir,
			artifactsDir,
			agentId: "author.verifier",
			taskDepth: 2,
			registry,
		});

		const authorPost = new PostMessageTool(authorSession);
		const verifierWait = new SwarmWaitTool(verifierSession);

		// 1. WaitCheck: message arrives BEFORE verifier calls swarm_wait{since: 1} -> returns immediately without blocking!
		await authorPost.execute("w1", { text: "@verifier please check diff in parser.ts" });
		const immediateWake = await verifierWait.execute("w2", { since: 1, mentions_only: true });
		expect(firstText(immediateWake)).toContain("Board message #2 arrived before waiting completed");
		expect(firstText(immediateWake)).toContain("@verifier please check diff");

		// 2. Sleeping waiter: ignores unaddressed chatter, wakes immediately when @mentioned!
		const sleepingPromise = verifierWait.execute("w3", { since: 2, mentions_only: true });
		await runtime.waitUntilParked("verifier");

		// While parked in swarm_wait, status reports verifier as `waiting`
		const statusMd = await runtime.formatStatusMarkdown(registry);
		expect(statusMd).toContain("**@verifier** (waiting");

		// Unaddressed post #3 does NOT wake verifier (mentions_only: true)
		await authorPost.execute("w4", { text: "Refactored helper function internally" });
		expect(runtime.isParked("verifier")).toBe(true);
		// Direct @verifier post #4 rings doorbell and resolves sleepingPromise with both #3 and #4!
		await authorPost.execute("w5", { text: "@verifier ready for round 2 review (#3)" });
		const wokenResult = await sleepingPromise;
		expect(wokenResult.isError).toBeUndefined();
		expect(firstText(wokenResult)).toContain("woke on #4 from @author");
		expect(firstText(wokenResult)).toContain("Refactored helper function internally");
		expect(firstText(wokenResult)).toContain("@verifier ready for round 2 review (#3)");

		// 3. Ownership rules: verifier (added by author) cannot kill author or coordinator; author CAN model-switch & kill verifier!
		const verifierSwarm = new SwarmTool(verifierSession);
		const badKill = await verifierSwarm.execute("w6", { action: "kill", name: "author" });
		expect(badKill.isError).toBe(true);
		expect(firstText(badKill)).toContain("you may kill only the workers you added");

		// Park verifier again and let author switch its model -> wakes verifier with model switch notice!
		const modelWakePromise = verifierWait.execute("w7", { since: 4, mentions_only: true });
		await runtime.waitUntilParked("verifier");
		const authorSwarm = new SwarmTool(authorSession);
		const switchRes = await authorSwarm.execute("w8", {
			action: "model",
			name: "verifier",
			model: "apphub/ag/gemini-4-argon-high-400k",
		});
		expect(switchRes.isError).toBeUndefined();
		const modelWoken = await modelWakePromise;
		expect(firstText(modelWoken)).toContain("@author switched you to the model apphub/ag/gemini-4-argon-high-400k");

		// Author kills its helper `verifier` cleanly
		const okKill = await authorSwarm.execute("w9", { action: "kill", name: "verifier" });
		expect(okKill.isError).toBeUndefined();
		expect(firstText(okKill)).toContain("Killed worker @verifier");
	});

	it("sanitizes narrator view.json with priority ranking, fallback on corrupt writes, and renders /swarm board & overview", async () => {
		const coordSession = makeToolSession({
			cwd: tmpDir,
			artifactsDir,
			agentId: MAIN_AGENT_ID,
			taskDepth: 0,
			registry,
		});
		const runtime = SwarmRuntime.forSession(coordSession);
		await runtime.ensureCoordinatorSwarm(coordSession, "Hub Layout Polish");
		await runtime.postAndRing({ session: coordSession, text: "Kickoff post #1" });

		// Write valid narrator view.json with out-of-order attention items (fyi before decision)
		await Bun.write(
			runtime.store.viewJsonPath,
			JSON.stringify({
				version: 1,
				as_of_seq: 1,
				updated_at: "2026-11-11T09:00:00Z",
				goal: { title: "Polish Hub split-pane cards", line: "1 of 2 workstreams in review" },
				headline: "Auditing split-pane spacing.",
				phase: { label: "Review", index: 2, total: 3 },
				attention: [
					{ id: "att-note", kind: "fyi", severity: "low", title: "Screenshots saved", refs: [{ seq: 1 }] },
					{
						id: "att-top-gap",
						kind: "decision",
						severity: "high",
						title: "Keep top split flush at 0px?",
						why: "Blocks final CSS commit",
						refs: [{ seq: 1 }],
					},
				],
				workstreams: [
					{
						id: "ws-split",
						title: "Split pane CSS",
						owners: ["coordinator"],
						state: "review",
						progress: { done: 2, total: 3 },
						refs: [{ seq: 1 }],
					},
				],
				milestones: [],
				risks: [],
			}),
		);

		const boardView = await runtime.formatLiveBoardView({ registry });
		expect(boardView).toContain("## Swarm: Hub Layout Polish");
		expect(boardView).toContain("**Goal:** Polish Hub split-pane cards");
		// Decision MUST be ranked ahead of FYI!
		expect(boardView.indexOf("[DECISION · high]")).toBeLessThan(boardView.indexOf("[FYI · low]"));
		expect(boardView).toContain("`[review]` **Split pane CSS** [2/3]");

		// Corrupt write falls back to last-good-parse instead of crashing or losing the Overview!
		await Bun.write(runtime.store.viewJsonPath, "{corrupt half-written json");
		const fallbackOverview = await runtime.store.readNarratorOverview(1, new Set(["coordinator"]));
		expect(fallbackOverview?.stale_fallback).toBe(true);
		expect(fallbackOverview?.goal?.title).toBe("Polish Hub split-pane cards");

		// /swarm slash command registration & headless expansion
		const swarmCmd = BUILTIN_AGY_COMPAT_SLASH_COMMANDS.find(c => c.name === "swarm");
		expect(swarmCmd).toBeDefined();
		const expanded = await expandAgyCompatSlashCommand("/swarm Refactor lexer and parser in parallel", tmpDir);
		expect(expanded).toContain("<NATIVE_SWARM>");
		expect(expanded).toContain("You are the swarm coordinator");
		expect(expanded).toContain("Refactor lexer and parser in parallel");
	});
});
