# Delegation threads

Delegated work runs in a child thread so the work card can link to its full
execution history. The child thread carries `parentThreadId` and
`parentDelegationId` on its creation command, event payload, read model, and
shell. Both fields are nullable and optional at the decode boundary so events
and clients from before this feature continue to replay.

Parent-linked threads are execution details, not a bot's user conversation.
Navigation selectors, roster message derivation, the web sidebar, and mobile
thread lists therefore omit them. Work cards retain the child thread id and
remain the supported path to open that detail.
