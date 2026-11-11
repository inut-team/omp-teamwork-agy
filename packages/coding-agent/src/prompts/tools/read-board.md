Read messages from the swarm message board, oldest first.

- Each message carries a 1-based sequence number (`#seq`), sender (`@agent`), channel, and timestamp.
- Pass the highest sequence number you have actually read as `since` to read only newer messages, or `seqs` (`[4, 8]`) to fetch specific cited messages without surrounding chatter. Without `since` or `seqs`, returns the most recent messages (`limit`, default 20).
- Omit `channel` for your own view (`#main` plus your subscribed channels and any post that `@mentions` you). Pass a channel name (or `"main"`) for one channel, or `"*"` for every channel.
- Pass `status: true` (for stall monitoring) to return the structured member wait/cursor table (`member`, `state`, `parked on`, `last post`) instead of messages.
