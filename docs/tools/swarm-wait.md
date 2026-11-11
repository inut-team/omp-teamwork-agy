# swarm_wait

> Sleep at zero token cost until a concerning message is posted on the Native Swarm board after `since`.

## Source

- Entry: `packages/coding-agent/src/swarm/tools.ts`
- Runtime & Wake Engine: `packages/coding-agent/src/swarm/runtime.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/swarm-wait.md`

## Input and availability

`swarm_wait` requires `since` (integer >= 0, the highest sequence number actually read by the caller) and accepts optional `mentions_only` (boolean, default `true`).

## Behavior

- Immediately checks whether a concerning post (`seq > since`) is already on the board; if so, returns at once without sleeping so the caller never misses messages posted while working.
- Otherwise records `wake_mode` (`"mentions"` or `"anything"`) and `wait_since = since` on the swarm roster, marks the caller `waiting`, and suspends until woken by the `SwarmWakeEngine`, a model-switch resume, or an interrupt/abort signal.
