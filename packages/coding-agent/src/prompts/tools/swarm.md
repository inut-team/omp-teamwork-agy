Manage the swarm of agents working with you on the shared message board.

Actions:
- `add`: Spawn a worker under a unique lowercase roster `name` (or `<name>-1`..`<name>-<k>` when `tasks` or `n` is set), optionally pinned to `model`, and post `brief` publicly on the board as `@<name> <brief>`. By default a worker starts fresh on your active model and sees nothing of this conversation, so `brief` MUST state what it owns, what it must not touch, and what "done" looks like. Pass `fork: "<member>"` (or `"coordinator"`) to branch from that member's conversation history instead. Pass `workspace: "share"` to give concurrent editing/building authors their own working copy of your repository (`"branch"` for an isolated branch clone; keep `"inherit"` for readers, verifiers, `narrator`, and `monitor`).
- `status`: Show every swarm member's state (`waiting`, `working`, `stopped`, `killed`), model, workspace, subscribed channels, unread count, and last post.
- `models`: List models available for `add` and `model` (`all: true` lists all configured models).
- `model`: Switch a waiting worker's model (or your own when `name` is omitted / your own name) while preserving its conversation history. Leave `model` off when switching a worker to put it on your own active model.
- `kill`: Permanently retire a worker (or all `<name>-1`..`<name>-<k>` copies when addressing a group prefix) and release its isolated workspace; killed names cannot be reused. Workers may `kill` or `model`-switch only helpers they added themselves; the coordinator may manage any worker.
- `title`: Set a short descriptive title for the swarm (coordinator only).
- `channel`: Split the board into scoped work-area channels (`op`: `"create"` | `"archive"` | `"subscribe"` | `"unsubscribe"` | `"list"`). Everyone is always in `#main`; `coordinator`, `narrator`, and `monitor` see every channel; workers see `#main`, their subscribed channels, and any post that `@mentions` them.
