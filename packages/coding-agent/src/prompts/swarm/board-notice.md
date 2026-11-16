{{#if isModelSwitch}}
{{#if selfSwitched}}
{{#if isCoordinator}}
You switched to the model {{model}}. Continue coordinating the swarm from where you left off.
{{else}}
You switched to the model {{model}}. If your assignment is unfinished, carry on with it where you left off; otherwise call `swarm_wait`.
{{/if}}
{{else}}
{{actorLabel}} switched you to the model {{model}}. If your assignment is unfinished, carry on with it where you left off; otherwise call `swarm_wait`.
{{/if}}
{{else if isTimeout}}
[swarm] `swarm_wait` timer elapsed ({{timeoutMs}} ms; board head is #{{headSeq}}, your cursor is #{{lastReadSeq}}). Inspect `read_board{since:{{lastReadSeq}}}` and `read_board{status:true}`, act if needed, or return to `swarm_wait`.
{{else}}
[swarm] new board message #{{seq}} from @{{sender}}{{#if channelTag}} ({{channelTag}}){{/if}}:
{{preview}}

[board] the latest message is #{{headSeq}} (you have read up to #{{lastReadSeq}}). Call `read_board{since:{{lastReadSeq}}}` to read everything you missed, act on your assignment, and wait for messages when you have nothing left to do.
{{/if}}
