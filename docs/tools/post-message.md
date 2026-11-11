# post_message

> Post a message to the shared Native Swarm board (`board.jsonl`) and ring `@mention` wakeup doorbells.

## Source

- Entry: `packages/coding-agent/src/swarm/tools.ts`
- Mentions & Channels: `packages/coding-agent/src/swarm/mentions.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/post-message.md`

## Input and availability

`post_message` takes `text` (required) and optional `channel` (defaults to the caller's home channel, else `"main"`).

## Behavior

- Appends an ordered message with a monotonic 1-based `seq` to `board.jsonl` tagged with the caller's swarm roster name.
- Validates channel names and rejects `@#main` (instructing the caller to use `@all`).
- Triggers the `SwarmWakeEngine` doorbell for sleeping members matching `@name`, `@group-prefix`, `@#channel` (active channel), `@all`, or visible channel posts for members waiting with `mentions_only: false`.
