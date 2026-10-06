import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { prompt, Snowflake, untilAborted } from "@oh-my-pi/pi-utils";
import backgroundTeamworkForkDispatchPrompt from "../prompts/system/background-teamwork-fork-dispatch.md" with { type: "text" };
import backgroundTeamworkForkPreviewDispatchPrompt from "../prompts/system/background-teamwork-fork-preview-dispatch.md" with { type: "text" };
import teamworkForkContextSwitchPrompt from "../prompts/system/teamwork-fork-context-switch.md" with { type: "text" };
import teamworkForkPreviewContextSwitchPrompt from "../prompts/system/teamwork-fork-preview-context-switch.md" with { type: "text" };
import { resolveTeamworkForkModel, resolveTeamworkForkPreviewModel } from "./teamwork-fork-model";
export * from "./teamwork-fork-model";
import type { InteractiveModeContext } from "../modes/types";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import * as sdk from "../sdk";
import type { AgentSession } from "../session/agent-session";
import { BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE } from "../session/messages";
import { SessionManager } from "../session/session-manager";
import type { SlashCommandResult, SlashCommandRuntime } from "../slash-commands/types";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "../tools/todo";
import { createMCPProxyTools, createSubagentSettings } from "./executor";
import { cfgTaskEnableLsp } from "./settings";

const FORK_LABEL_PREVIEW_LENGTH = 80;

function previewWork(work: string): string {
	const singleLine = work.trim().replace(/\s+/g, " ");
	if (singleLine.length <= FORK_LABEL_PREVIEW_LENGTH) return singleLine;
	return `${singleLine.slice(0, FORK_LABEL_PREVIEW_LENGTH - 1)}…`;
}

function extractAssistantText(message: AssistantMessage | undefined): string {
	if (!message) return "";
	return message.content
		.filter(content => content.type === "text")
		.map(content => content.text)
		.join("")
		.trim();
}

async function removeCloneSession(cloneFile: string): Promise<void> {
	await Promise.allSettled([
		fs.rm(cloneFile, { force: true }),
		fs.rm(cloneFile.slice(0, -6), { recursive: true, force: true }),
	]);
}

interface TeamworkForkExecutionOptions {
	preview?: boolean;
}

async function runTeamworkForkTuiCore(
	ctx: InteractiveModeContext,
	work: string,
	options?: TeamworkForkExecutionOptions,
): Promise<void> {
	const isPreview = options?.preview === true;
	const commandName = isPreview ? "/teamwork-fork-preview" : "/teamwork-fork";
	const clonePrefix = isPreview ? "TeamworkForkPreview" : "TeamworkFork";
	const agentDisplayName = isPreview ? "teamwork-fork-preview" : "teamwork-fork";
	const dispatchPrompt = isPreview
		? backgroundTeamworkForkPreviewDispatchPrompt
		: backgroundTeamworkForkDispatchPrompt;
	const contextSwitchPrompt = isPreview ? teamworkForkPreviewContextSwitchPrompt : teamworkForkContextSwitchPrompt;

	const trimmedWork = work.trim();
	if (!trimmedWork) {
		ctx.showStatus(`Usage: ${commandName} <task>`);
		return;
	}

	const session = ctx.session;
	const { model, thinkingLevel } = isPreview
		? resolveTeamworkForkPreviewModel(session)
		: resolveTeamworkForkModel(session);
	if (!model) {
		ctx.showError(`No model available for ${commandName}.`);
		return;
	}

	const manager = session.asyncJobManager;
	if (!manager) {
		ctx.showError(`Background jobs are disabled; enable async jobs to use ${commandName}.`);
		return;
	}

	const parentFile = ctx.sessionManager.getSessionFile();
	if (!parentFile) {
		ctx.showError(`${commandName} requires a persisted session.`);
		return;
	}

	const parentSessionId = session.sessionId;
	const parentPromptCacheKey = session.agent.promptCacheKey ?? parentSessionId;
	const systemPrompt = [...session.systemPrompt];
	const toolNames = session.getEnabledToolNames();
	const modelRegistry = session.modelRegistry;
	const parentPreparedExtensions = session.preparedExtensions;
	const parentExtensionPaths = session.extensionPaths;
	const parentExtensionRoots = session.effectiveExtensionRoots;
	const ownerId = session.getAgentId() ?? MAIN_AGENT_ID;
	const mcpManager = ctx.mcpManager;
	const cwd = ctx.sessionManager.getCwd();
	const parentArtifactsDir = ctx.sessionManager.getArtifactsDir();
	const parentLocalSessionId = ctx.sessionManager.getSessionId();
	const localProtocolOptions = {
		getArtifactsDir: () => parentArtifactsDir,
		getSessionId: () => parentLocalSessionId,
	};
	const sessionDir = parentFile.slice(0, -6);

	const settings = isPreview
		? createSubagentSettings(ctx.settings)
		: createSubagentSettings(ctx.settings, {
				"task.agentModelOverrides": {
					"teamwork-fork": "",
				},
			});
	const customTools = mcpManager ? createMCPProxyTools(mcpManager) : undefined;
	const enableLsp = cfgTaskEnableLsp.get(ctx.settings) !== false;
	const agentRegistry = AgentRegistry.global();
	const cloneId = `${clonePrefix}-${Snowflake.next()}`;
	const cloneFile = path.join(sessionDir, `${cloneId}.jsonl`);
	const label = `${commandName} ${previewWork(trimmedWork)}`;

	await ctx.sessionManager.ensureOnDisk();
	await ctx.sessionManager.flush();

	let jobId = "";
	try {
		const cloneManager = await SessionManager.forkFrom(parentFile, cwd, sessionDir, undefined, {
			copyArtifacts: false,
			suppressBreadcrumb: true,
			sessionFile: cloneFile,
			resetInheritedCost: true,
			repairInterruptedTail: true,
		});

		jobId = manager.register(
			"task",
			label,
			async ({ signal }: { signal: AbortSignal }) => {
				if (signal.aborted) throw new Error("Aborted before execution");

				let clone: AgentSession | undefined;
				try {
					const created = await sdk.createAgentSession({
						cwd,
						sessionManager: cloneManager,
						model,
						thinkingLevel,
						systemPrompt,
						toolNames,
						providerSessionId: `${parentSessionId}:${agentDisplayName}:${Snowflake.next()}`,
						providerPromptCacheKey: parentPromptCacheKey,
						modelRegistry,
						authStorage: modelRegistry.authStorage,
						settings,
						hasUI: false,
						enableMCP: false,
						customTools,
						enableLsp,
						agentId: cloneId,
						agentDisplayName,
						parentTaskPrefix: cloneId,
						parentAgentId: ownerId,
						agentRegistry,
						disableExtensionDiscovery: true,
						preloadedPreparedExtensions: parentPreparedExtensions?.length ? parentPreparedExtensions : undefined,
						preloadedExtensionPaths: parentExtensionPaths?.length ? [...parentExtensionPaths] : undefined,
						extensionRoots: () => parentExtensionRoots,
						localProtocolOptions,
					});
					clone = created.session;
					clone.sessionManager?.appendSessionInit?.({
						systemPrompt: clone.systemPrompt ?? systemPrompt,
						task: trimmedWork,
						tools: clone.getEnabledToolNames(),
					});
					const abortClone = () => {
						void clone?.abort();
					};
					signal.addEventListener("abort", abortClone, { once: true });

					clone.setTodoPhases([]);
					cloneManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: [] });

					const injectContextSwitch = () => {
						clone?.agent.appendMessage({
							role: "developer",
							content: contextSwitchPrompt,
							attribution: "agent",
							timestamp: Date.now(),
						});
					};

					let requestDispatched = false;
					const unsubscribeCompaction = clone.subscribe(event => {
						if (event.type === "agent_start") {
							requestDispatched = true;
							return;
						}
						if (event.type !== "auto_compaction_end" || !event.result || event.aborted) return;
						if (!requestDispatched) {
							injectContextSwitch();
							return;
						}
						const requestRetained = (clone?.agent.state.messages ?? []).some(message => {
							if (message.role !== "user") return false;
							const content = message.content;
							return typeof content === "string"
								? content === trimmedWork
								: content.some(part => part.type === "text" && part.text === trimmedWork);
						});
						if (requestRetained) return;
						injectContextSwitch();
						clone?.agent.appendMessage({
							role: "user",
							content: [{ type: "text", text: trimmedWork }],
							attribution: "user",
							timestamp: Date.now(),
						});
					});

					try {
						if (signal.aborted) {
							abortClone();
							throw new Error("Aborted before execution");
						}
						injectContextSwitch();
						await clone.prompt(trimmedWork, { attribution: "user" });
						await clone.waitForIdle();
						while (clone.hasPendingAsyncWork()) {
							if (signal.aborted) throw new Error("Aborted while settling descendant work");
							await untilAborted(signal, clone.settleAsyncWork());
						}
						return extractAssistantText(clone.getLastAssistantMessage()) || "(no output)";
					} finally {
						unsubscribeCompaction();
						signal.removeEventListener("abort", abortClone);
					}
				} finally {
					if (clone) {
						if (signal.aborted) {
							agentRegistry.setStatus(cloneId, "aborted");
							await clone.dispose();
						} else {
							agentRegistry.setStatus(cloneId, "parked");
							await clone.dispose();
							agentRegistry.detachSession(cloneId);
						}
					}
				}
			},
			{ ownerId, agentId: cloneId },
		);
	} catch (error) {
		if (cloneFile) await removeCloneSession(cloneFile);
		ctx.showError(error instanceof Error ? error.message : String(error));
		return;
	}

	const content = prompt.render(dispatchPrompt, {
		jobId,
		work: trimmedWork,
		modelId: model.id,
	});
	const wasStreaming = session.isStreaming;
	await session.sendCustomMessage(
		{
			customType: BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE,
			content,
			display: true,
			attribution: "user",
			details: { jobId, work: trimmedWork, sessionFile: cloneFile },
		},
		{ triggerTurn: false, deliverAs: "nextTurn" },
	);
	if (!wasStreaming) ctx.rebuildChatFromMessages();
	ctx.showStatus(`Dispatched background ${agentDisplayName} ${jobId}`);
}

async function runTeamworkForkAcpCore(
	runtime: SlashCommandRuntime,
	work: string,
	options?: TeamworkForkExecutionOptions,
): Promise<SlashCommandResult> {
	const isPreview = options?.preview === true;
	const commandName = isPreview ? "/teamwork-fork-preview" : "/teamwork-fork";
	const clonePrefix = isPreview ? "TeamworkForkPreview" : "TeamworkFork";
	const agentDisplayName = isPreview ? "teamwork-fork-preview" : "teamwork-fork";
	const contextSwitchPrompt = isPreview ? teamworkForkPreviewContextSwitchPrompt : teamworkForkContextSwitchPrompt;
	const promptTag = isPreview ? "TEAMWORK_FORK_PREVIEW" : "TEAMWORK_FORK";
	const promptDesc = isPreview
		? "Execute this task using the model configured in /agents:"
		: "Execute this task using the full default model:";
	const resultHeader = isPreview ? "[Teamwork Fork Preview Complete]" : "[Teamwork Fork Complete]";

	const trimmedWork = work.trim();
	if (!trimmedWork) {
		await runtime.output(`Usage: ${commandName} <task>`);
		return { consumed: true };
	}

	const session = runtime.session;
	const { model, thinkingLevel } = isPreview
		? resolveTeamworkForkPreviewModel(session)
		: resolveTeamworkForkModel(session);
	if (!model) {
		await runtime.output(`Error: No model available for ${commandName}.`);
		return { consumed: true };
	}

	const parentFile = runtime.sessionManager?.getSessionFile?.();
	if (!parentFile) {
		return {
			prompt: `<${promptTag}>\n${promptDesc}\n\n${trimmedWork}\n</${promptTag}>`,
		};
	}

	const cwd = runtime.cwd;
	const sessionDir = parentFile.slice(0, -6);
	const cloneId = `${clonePrefix}-${Snowflake.next()}`;
	const cloneFile = path.join(sessionDir, `${cloneId}.jsonl`);

	await runtime.sessionManager.ensureOnDisk();
	await runtime.sessionManager.flush();

	const cloneManager = await SessionManager.forkFrom(parentFile, cwd, sessionDir, undefined, {
		copyArtifacts: false,
		suppressBreadcrumb: true,
		sessionFile: cloneFile,
		resetInheritedCost: true,
		repairInterruptedTail: true,
	});

	const settings = isPreview
		? createSubagentSettings(runtime.settings)
		: createSubagentSettings(runtime.settings, {
				"task.agentModelOverrides": {
					"teamwork-fork": "",
				},
			});

	try {
		const created = await sdk.createAgentSession({
			cwd,
			sessionManager: cloneManager,
			model,
			thinkingLevel,
			systemPrompt: [...session.systemPrompt],
			toolNames: session.getEnabledToolNames(),
			providerSessionId: `${session.sessionId}:${agentDisplayName}:${Snowflake.next()}`,
			modelRegistry: session.modelRegistry,
			authStorage: session.modelRegistry?.authStorage,
			settings,
			hasUI: false,
			enableMCP: false,
			enableLsp: false,
			agentId: cloneId,
			agentDisplayName,
			parentAgentId: session.getAgentId() ?? MAIN_AGENT_ID,
			disableExtensionDiscovery: true,
		});

		const clone = created.session;
		clone.setTodoPhases([]);
		cloneManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: [] });

		clone.agent.appendMessage({
			role: "developer",
			content: contextSwitchPrompt,
			attribution: "agent",
			timestamp: Date.now(),
		});

		await clone.prompt(trimmedWork, { attribution: "user" });
		await clone.waitForIdle();
		const resultText = extractAssistantText(clone.getLastAssistantMessage()) || "(no output)";
		await clone.dispose();
		await runtime.output(`${resultHeader}:\n${resultText}`);
		return { consumed: true };
	} finally {
		await removeCloneSession(cloneFile);
	}
}

export async function runTeamworkForkTui(ctx: InteractiveModeContext, work: string): Promise<void> {
	return runTeamworkForkTuiCore(ctx, work, { preview: false });
}

export async function runTeamworkForkPreviewTui(ctx: InteractiveModeContext, work: string): Promise<void> {
	return runTeamworkForkTuiCore(ctx, work, { preview: true });
}

export async function runTeamworkForkAcp(runtime: SlashCommandRuntime, work: string): Promise<SlashCommandResult> {
	return runTeamworkForkAcpCore(runtime, work, { preview: false });
}

export async function runTeamworkForkPreviewAcp(
	runtime: SlashCommandRuntime,
	work: string,
): Promise<SlashCommandResult> {
	return runTeamworkForkAcpCore(runtime, work, { preview: true });
}
