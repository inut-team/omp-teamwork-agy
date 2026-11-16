{{#if callsOnYou}}
[board] new messages call on you; `read_board{since:{{lastReadSeq}}}` before ending your turn.
{{else}}
[board] the latest message is #{{headSeq}} (you have read up to #{{lastReadSeq}}); call `read_board{since:{{lastReadSeq}}}` and `swarm_wait` when you have nothing left to do.
{{/if}}
