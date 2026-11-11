import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import postMessagePrompt from "../prompts/tools/post-message.md" with { type: "text" };
import readBoardPrompt from "../prompts/tools/read-board.md" with { type: "text" };
import swarmPrompt from "../prompts/tools/swarm.md" with { type: "text" };
import swarmWaitPrompt from "../prompts/tools/swarm-wait.md" with { type: "text" };
import type { ToolSession } from "../tools";
import { messageChannelOf } from "./mentions";
import { formatBoardMessagesMarkdown, promoteSwarmToolsOnSession, SwarmRuntime } from "./runtime";
import type { SwarmChannelOp, SwarmRole, SwarmToolDetails, SwarmWorkspaceMode } from "./types";

const swarmSchema = type({
	action: '"status" | "models" | "add" | "model" | "kill" | "title" | "channel"',
	"name?": "string",
	"brief?": "string",
	"model?": "string",
	"all?": "boolean",
	"workspace?": '"inherit" | "share" | "branch"',
	"fork?": "string",
	"n?": "number.integer >= 1",
	"tasks?": "string[]",
	"title?": "string",
	"op?": '"create" | "archive" | "subscribe" | "unsubscribe" | "list"',
	"channel?": "string",
	"topic?": "string",
	"channels?": "string[]",
	"role?": '"worker" | "narrator" | "monitor"',
});

const postMessageSchema = type({
	text: "string",
	"channel?": "string",
});

const readBoardSchema = type({
	"since?": "number.integer >= 0",
	"limit?": "number.integer >= 1",
	"seqs?": "number.integer[]",
	"channel?": "string",
	"status?": "boolean",
});

const swarmWaitSchema = type({
	since: "number.integer >= 0",
	"mentions_only?": "boolean",
});

function errorResult(text: string, details: SwarmToolDetails): AgentToolResult<SwarmToolDetails> {
	return {
		content: [{ type: "text", text }],
		details,
		isError: true,
	};
}

export class SwarmTool implements AgentTool<typeof swarmSchema, SwarmToolDetails> {
	readonly name = "swarm";
	readonly label = "Swarm";
	readonly summary =
		"Manage the native swarm of agents on the shared message board (status, models, add, model, kill, title, channel)";
	readonly description = prompt.render(swarmPrompt).trim();
	readonly parameters = swarmSchema;
	readonly strict = true;
	readonly approval = "read";
	readonly loadMode = "discoverable";
	readonly intent = "optional";

	constructor(private readonly session: ToolSession) {}

	async execute(_toolCallId: string, params: typeof swarmSchema.infer): Promise<AgentToolResult<SwarmToolDetails>> {
		const runtime = SwarmRuntime.forSession(this.session);
		const baseDetails: SwarmToolDetails = {
			tool: "swarm",
			action: params.action,
			swarmDir: runtime.store.dir,
		};

		try {
			switch (params.action) {
				case "status": {
					const text = await runtime.formatStatusMarkdown(this.session.agentRegistry);
					const snap = await runtime.store.getSnapshot();
					return {
						content: [{ type: "text", text }],
						details: { ...baseDetails, head: snap.head, swarmId: snap.roster?.swarm_id },
					};
				}
				case "models": {
					const text = runtime.listModelsMarkdown(this.session, params.all === true);
					return {
						content: [{ type: "text", text }],
						details: baseDetails,
					};
				}
				case "title": {
					if ((this.session.taskDepth ?? 0) === 0) {
						await runtime.ensureCoordinatorSwarm(this.session, params.title);
					}
					promoteSwarmToolsOnSession(this.session);
					const snap = await runtime.store.getSnapshot();
					const actor = runtime.resolveActorName(this.session, snap.roster);
					const roster = await runtime.store.setTitle(actor, params.title ?? "");
					return {
						content: [{ type: "text", text: `Titled swarm "${roster.title}" (SWARM_DIR=${runtime.store.dir}).` }],
						details: { ...baseDetails, swarmId: roster.swarm_id, actor },
					};
				}
				case "add": {
					if (!params.name) {
						return errorResult('name is required for action "add"', baseDetails);
					}
					if (!params.brief) {
						return errorResult(
							"brief is required: a worker starts fresh and does nothing without one",
							baseDetails,
						);
					}
					const res = await runtime.spawnMembers({
						session: this.session,
						name: params.name,
						brief: params.brief,
						model: params.model,
						workspace: params.workspace as SwarmWorkspaceMode | undefined,
						fork: params.fork,
						n: params.n,
						tasks: params.tasks,
						channels: params.channels,
						role: params.role as SwarmRole | undefined,
					});
					return {
						content: [{ type: "text", text: res.text }],
						details: { ...baseDetails, added: res.added, seq: res.seq, head: res.head },
					};
				}
				case "kill": {
					if (!params.name) {
						return errorResult('name is required for action "kill"', baseDetails);
					}
					const res = await runtime.killMembers({
						session: this.session,
						name: params.name,
					});
					return {
						content: [{ type: "text", text: res.text }],
						details: { ...baseDetails, killed: res.killed },
					};
				}
				case "model": {
					const res = await runtime.switchMemberModel({
						session: this.session,
						name: params.name,
						model: params.model,
					});
					return {
						content: [{ type: "text", text: res.text }],
						details: baseDetails,
					};
				}
				case "channel": {
					const op = params.op as SwarmChannelOp | undefined;
					if (!op) {
						return errorResult(
							'op is required for action "channel": want one of create, archive, subscribe, unsubscribe, list',
							baseDetails,
						);
					}
					if ((this.session.taskDepth ?? 0) === 0 && op === "create") {
						await runtime.ensureCoordinatorSwarm(this.session);
						promoteSwarmToolsOnSession(this.session);
					}
					const snap = await runtime.store.getSnapshot();
					const actor = runtime.resolveActorName(this.session, snap.roster);
					const res = await runtime.store.executeChannelOp({
						actor,
						op,
						channel: params.channel,
						topic: params.topic,
						targetMember: params.name,
					});
					return {
						content: [{ type: "text", text: res.text }],
						details: { ...baseDetails, actor, channel: params.channel, seq: res.message?.seq },
					};
				}
			}
		} catch (err) {
			return errorResult(err instanceof Error ? err.message : String(err), baseDetails);
		}
	}
}

export class PostMessageTool implements AgentTool<typeof postMessageSchema, SwarmToolDetails> {
	readonly name = "post_message";
	readonly label = "Post Message";
	readonly summary = "Post a message to the shared swarm board and ring @mention wakeup doorbells";
	readonly description = prompt.render(postMessagePrompt).trim();
	readonly parameters = postMessageSchema;
	readonly strict = true;
	readonly approval = "read";
	readonly loadMode = "discoverable";
	readonly intent = "optional";

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: typeof postMessageSchema.infer,
	): Promise<AgentToolResult<SwarmToolDetails>> {
		const runtime = SwarmRuntime.forSession(this.session);
		const baseDetails: SwarmToolDetails = {
			tool: "post_message",
			swarmDir: runtime.store.dir,
		};
		try {
			const { actor, message, warnings } = await runtime.postAndRing({
				session: this.session,
				text: params.text,
				channel: params.channel,
			});
			const ch = messageChannelOf(message);
			const warningSuffix = warnings.length > 0 ? `\nNote: ${warnings.join("; ")}` : "";
			return {
				content: [
					{
						type: "text",
						text: `Posted #${message.seq} as @${actor} in #${ch}.${warningSuffix}`,
					},
				],
				details: { ...baseDetails, actor, seq: message.seq, head: message.seq, channel: ch },
			};
		} catch (err) {
			return errorResult(err instanceof Error ? err.message : String(err), baseDetails);
		}
	}
}

export class ReadBoardTool implements AgentTool<typeof readBoardSchema, SwarmToolDetails> {
	readonly name = "read_board";
	readonly label = "Read Board";
	readonly summary = "Read messages or member wait status from the shared swarm message board";
	readonly description = prompt.render(readBoardPrompt).trim();
	readonly parameters = readBoardSchema;
	readonly strict = true;
	readonly approval = "read";
	readonly loadMode = "discoverable";
	readonly intent = "optional";

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: typeof readBoardSchema.infer,
	): Promise<AgentToolResult<SwarmToolDetails>> {
		const runtime = SwarmRuntime.forSession(this.session);
		const baseDetails: SwarmToolDetails = {
			tool: "read_board",
			swarmDir: runtime.store.dir,
		};
		try {
			if (params.status === true) {
				const table = await runtime.formatMonitorStatusTable(this.session.agentRegistry);
				const snap = await runtime.store.getSnapshot();
				return {
					content: [{ type: "text", text: table }],
					details: { ...baseDetails, head: snap.head },
				};
			}

			const snap = await runtime.store.getSnapshot();
			if (!snap.roster) {
				return {
					content: [{ type: "text", text: "No swarm yet (0 messages)." }],
					details: { ...baseDetails, head: 0 },
				};
			}
			const actor = runtime.resolveActorName(this.session, snap.roster);
			const view = await runtime.store.readView({
				memberName: actor,
				since: params.since,
				limit: params.limit,
				seqs: params.seqs,
				channel: params.channel,
				advanceCursor: true,
			});

			if (view.messages.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `${view.channelLabel} (0 new messages; board head #${view.head}, your cursor #${view.lastReadSeq}).`,
						},
					],
					details: { ...baseDetails, actor, head: view.head },
				};
			}

			const first = view.messages[0]!.seq;
			const last = view.messages[view.messages.length - 1]!.seq;
			const rangeLabel =
				view.messages.length === 1
					? `1 message from ${view.channelLabel} (#${first}; board head #${view.head})`
					: `${view.messages.length} messages from ${view.channelLabel} (#${first}–#${last}; board head #${view.head})`;
			const body = formatBoardMessagesMarkdown(view.messages);
			return {
				content: [{ type: "text", text: `${rangeLabel}\n\n${body}` }],
				details: { ...baseDetails, actor, seq: last, head: view.head },
			};
		} catch (err) {
			return errorResult(err instanceof Error ? err.message : String(err), baseDetails);
		}
	}
}

export class SwarmWaitTool implements AgentTool<typeof swarmWaitSchema, SwarmToolDetails> {
	readonly name = "swarm_wait";
	readonly label = "Swarm Wait";
	readonly summary = "Sleep at zero token cost until a concerning message is posted on the swarm board";
	readonly description = prompt.render(swarmWaitPrompt).trim();
	readonly parameters = swarmWaitSchema;
	readonly strict = true;
	readonly interruptible = true;
	readonly handlesToolInterrupt = true;
	readonly approval = "read";
	readonly loadMode = "discoverable";
	readonly intent = "optional";

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: typeof swarmWaitSchema.infer,
		signal?: AbortSignal,
	): Promise<AgentToolResult<SwarmToolDetails>> {
		const runtime = SwarmRuntime.forSession(this.session);
		const baseDetails: SwarmToolDetails = {
			tool: "swarm_wait",
			swarmDir: runtime.store.dir,
		};
		try {
			const res = await runtime.waitForBoard({
				session: this.session,
				since: params.since,
				mentionsOnly: params.mentions_only ?? true,
				signal,
			});
			return {
				content: [{ type: "text", text: res.text }],
				details: { ...baseDetails, head: res.head, interrupted: res.interrupted },
			};
		} catch (err) {
			return errorResult(err instanceof Error ? err.message : String(err), baseDetails);
		}
	}
}
