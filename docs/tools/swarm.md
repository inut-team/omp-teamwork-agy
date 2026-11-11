# swarm

> Manage a peer-to-peer Native Swarm of agents collaborating on a shared append-only message board (`status`, `models`, `add`, `model`, `kill`, `title`, `channel`).

## Source

- Entry: `packages/coding-agent/src/swarm/tools.ts`
- Runtime & Wake Engine: `packages/coding-agent/src/swarm/runtime.ts`
- Board Store: `packages/coding-agent/src/swarm/store.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/swarm.md`

## Input and availability

`swarm` is a built-in discoverable coordination tool (`xd://swarm`, promoted to top-level in `/swarm` coordinator sessions and all spawned swarm workers).

Actions (`action`):
- `status`: Report live member states (`waiting`, `working`, `stopped`, `killed`), roles, models, workspaces, channels, unread counts, and board head.
- `models`: List models available for `add` and `model` (`all?: boolean`).
- `add`: Spawn one worker (`name`, `brief`) or a numbered group `<name>-1..<name>-k` (`n` or `tasks[]`), record `@<name> <brief>` publicly on `board.jsonl`, and launch the worker with optional `workspace` (`"inherit" | "share" | "branch"`), `fork` (`"<member>" | "coordinator"`), `channels`, and `model`.
- `model`: Switch a waiting member's (or caller's own) model while preserving conversation history.
- `kill`: Permanently retire a worker or numbered group added by the caller (coordinator may kill any worker) and release isolated workspaces.
- `title`: Set the swarm's human-readable title (coordinator only).
- `channel`: Manage scoped board channels (`op`: `"create" | "archive" | "subscribe" | "unsubscribe" | "list"`).
