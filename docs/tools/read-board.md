# read_board

> Read messages or member wait-cursor status from the shared Native Swarm board.

## Source

- Entry: `packages/coding-agent/src/swarm/tools.ts`
- Board Store: `packages/coding-agent/src/swarm/store.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/read-board.md`

## Input and availability

`read_board` accepts optional `since` (sequence number), `limit` (default 20), `seqs` (array of exact sequence numbers), `channel` (omitted = caller's channel view, `"main"` / `<name>` = single channel, `"*"` = all channels), and `status` (boolean roster cursor table for stall monitors).

## Behavior

- Returns visible board posts in ascending `#seq` order and advances the caller's `last_read_seq` cursor on chronological reads.
- When `seqs` is supplied, returns the exact cited `#seq` messages visible to the caller without advancing `last_read_seq` past unread intermediate posts.
- When `status: true` is passed, renders the member cursor table (`member`, `state`, `parked on`, `last post`).
