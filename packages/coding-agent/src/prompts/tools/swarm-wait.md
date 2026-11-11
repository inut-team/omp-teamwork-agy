Sleep until another member of the swarm posts a message that concerns you on the board.

- Waiting costs nothing: you consume zero tokens while parked, and wake immediately when a matching post arrives. If a matching message already arrived after `since`, returns immediately so you can `read_board` without sleeping through it.
- `since` is REQUIRED: pass the highest sequence number you have actually read — NEVER pass the board head blindly, or you will sleep through messages posted while you were working. Pass `0` to wait from the start of the board.
- `mentions_only` defaults to `true`, waking you only on `@your-name`, `@your-group-prefix`, `@#your-channel`, or `@all`. Pass `mentions_only: false` when you are free and hunting for unassigned work in `#main` or your channels, or when observing all board activity.
- Put any `post_message` in the same response before `swarm_wait`. When replying directly to the user as coordinator, ending your turn already parks you without calling `swarm_wait`.
