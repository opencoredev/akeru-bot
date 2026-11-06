# Bot permission policy

One policy decides whether a bot may take an action, must ask first, or must refuse. The decision is
pure: it takes the bot's policy, the principal the bot acts for, and the action's risk class, and
returns `allow`, `ask`, or `deny`. Server and clients share it.

- Types and schemas: [`packages/contracts/src/botPermissions.ts`](../../packages/contracts/src/botPermissions.ts)
- Decision and approval binding: [`packages/shared/src/botPermissions.ts`](../../packages/shared/src/botPermissions.ts), imported as `@akeru/shared/botPermissions`
- Risk classes: [`packages/shared/src/botActionRisk.ts`](../../packages/shared/src/botActionRisk.ts), built on the protected-action classifier in [`packages/shared/src/akeruActions.ts`](../../packages/shared/src/akeruActions.ts)
- Enforcement on the tool path: [`AkeruToolPermissions.ts`](../../apps/server/src/provider/tools/AkeruToolPermissions.ts), called by [`AkeruToolRuntime.ts`](../../apps/server/src/provider/AkeruToolRuntime.ts)

## Inputs

**Risk class.** Every action has one of four classes:

| Class                | Covers                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `read`               | Reads in the workspace or on the web                                                                             |
| `write-workspace`    | Changes inside the bot's own workspace, chats, profile, and memory                                               |
| `write-outside`      | Effects other people or systems see: sending, posting, paying, deleting, deploying, publishing, exposing secrets |
| `environment-access` | The user's own computer: local shell, user-computer reads and copies                                             |

One classifier recognizes protected actions: sending, paying, deleting, production changes,
secrets, publishing, signing, refunds, and account changes. The approval prompts and the risk class
both use it, so they cannot disagree. A recognized protected action is always `write-outside`,
whatever tool runs it and wherever it runs: `git clean -fd`, `git reset --hard`, and `rm -rf` are
outside writes in a local or cloud workspace, and `write-outside: deny` stops them.

Otherwise, `akeruToolRiskClassForInput` uses the catalog approval class for that input. The
protected classes map to `write-outside`, `user-computer` maps to `environment-access`, and `none`
uses the tool's base class in `AKERU_TOOL_BASE_RISK_CLASSES`. Every catalog tool id has an entry
there, so a new tool fails to compile until it gets one. `AwaitExternalShell` is
`environment-access` because it reads command output from the user's computer, and
`list_environments` is `read`. Actions outside the catalog, such as routine management,
use `namedActionRiskClass`: `akeru_delete_routines` is `write-outside`, `akeru_create_routine` is
`write-workspace`, and `akeru_list_routines` is `read`. The memory tool stays `write-workspace`,
because its operations only edit the bot's own memory.

**Principal.** Who the action is for:

- `owner`: the person who runs the environment. Every authenticated client is the owner today.
- `person`: someone the owner allowlisted on this bot.
- `schedule`: a routine run. It acts for the owner.
- `bot`: another bot asking for work. It carries `onBehalfOf`, the owner, person, or schedule that
  started the chain.

**Policy.** Each bot has `defaults` per risk class, `toolOverrides` keyed by tool name, and `people`,
the allowlist with a per-class cap for each person. A bot with no stored policy uses
`DEFAULT_BOT_PERMISSION_POLICY`: `write-outside` asks, every other class allows.

## Decision

1. The bot rule is the tool override if one exists, otherwise the risk-class default.
2. A bot principal is replaced by its `onBehalfOf` origin. Another bot never gets more than the
   person it acts for may do with the target bot.
3. The owner and schedules get the bot rule.
4. A person gets the stricter of the bot rule and their own cap. A person not on the allowlist is
   denied.

`deny` beats `ask`, and `ask` beats `allow`.

For Akeru's built-in tools, the policy decides whether the owner must answer. An explicit tool
override such as `ReactToMessage: allow` runs without a prompt, even for an action the old catalog
class would have asked about. A risk-class default of `allow` leaves the chat's
[permission mode](../user/permission-modes.md) in charge, so Supervised still asks before a cloud
`npm install`. Neither skips the mode's check for a local shell command. Installed MCP and Composio
connector tools keep their own rules. `ask` means the owner must
answer: Full access and Auto review cannot answer it for them, and the prompt offers only Approve and
Decline. `deny` fails the tool call before any prompt or backend runs.

The default policy asks everywhere the old protected-action rule asked, which the shared test
"asks everywhere the protected-action rule asked" checks for every catalog tool. It also asks before
protected actions the old rule missed, such as `git clean -fd` in a cloud workspace.

## Approval binding

When a call needs an answer, `openBotActionApproval` creates a binding with:

- the tool call id as `approvalId`, plus the bot and thread
- `requester`, the principal the call is for
- `answerer`, the principal allowed to answer, which is always the owner for now
- `action`: the tool id and a SHA-256 digest of the canonical JSON of the decoded arguments
- `environmentId`, from the server's environment identity
- `openedAt` and `expiresAt`, 24 hours later by default

A binding moves from open to granted to consumed. It must be open before anyone can answer it, so
an answer with no matching binding is `unknown-approval`. `checkBotApprovalAnswer` rejects an
answer after `expiresAt` (`expired`) and an answer from anyone but the answerer (`wrong-principal`).
Neither rejection closes the binding, so the owner can still answer. Any answer to a granted or
consumed binding is `already-answered`. A consumed binding stays as a tombstone until the thread's
approvals are cleared, so the identical call cannot be approved and run a second time. An answer
for different arguments lands on a different binding and never matches the call that runs.

A grant records who gave it. `owner-answer` is the owner responding to the prompt.
`permission-mode` is Full access or Auto review approving a routine call for the owner. A mode grant
is refused when the policy currently asks for the owner, and it never satisfies an owner ask at run
time (`owner-approval-required`).

Right before the tool runs, the runtime reads the bot's policy again and calls
`authorizeApprovedBotAction`. A permission revoked after approval blocks the run
(`denied-by-policy`), and so does a policy that now asks for the owner after a mode grant, an
expired binding, or a mismatched requester, action, or environment. That check consumes the grant,
so each grant covers one run.

## Where it runs

`AkeruToolRuntime` enforces the policy for every built-in tool, including the plugin and MCP
management tools and the bot's memory tool. The bot's session carries its principal and a
`readPolicy` reader that hits the projection on each async check, so a `bot.update` takes effect on
the next call. When a shared workspace reuses a session for another responding bot, only the
workspace carries over. `BotToolSession` rebuilds everything that speaks for a bot (identity,
principal, policy reader, memory, messages to the user, reactions, channels, delegation and workers)
for the new bot, and both the first start and the reuse path use it. The provider command reactor
reconfigures the session whenever a group hands the chat to a different bot, even when nothing else
changed, so the next turn never runs under the previous bot's policy. A handoff while the previous
bot still works is refused rather than queued with the old tools or swapped in mid-turn. The decider
rejects the `thread.turn.start` command while the chat shows work in flight (a starting or running
session, an active or running turn, or a turn start no session has picked up), so the responder does
not move and nothing is saved. The reactor keeps a backstop for what the read model cannot see: when
the provider session still reports an active turn, including one the controller is admitting, it
refuses with `GroupHandoffBusyError` before it writes any session state. That refusal is recorded
as a turn-start failure activity, which clears its pending turn start, and the running turn's
session keeps its status. The backstop cannot undo the responder change the decider already
accepted, so output from the previous bot's turn is attributed to the new responder. The
decider's check for a turn start no session has picked up compares client message timestamps
within the queued-turn grace window, so skewed client clocks can slip past it.
`AgentController` opens the
binding when Mastra asks for approval, records `owner-answer` when the user responds, and records
`permission-mode` when the chat mode approves a `mode` requirement.

Routine management goes through the same decision. `akeru_create_routine` checks the policy before
its review card opens and again when the owner accepts, before the routine is created.
`akeru_delete_routines` checks before asking and again after the owner confirms, before deleting.
The review card or confirmation question is the owner's answer to an `ask`.

`akeru_list_routines` has no review of its own, so it uses the same binding as catalog tools. Its
approval check reads the policy: `deny` refuses before anything is listed, and `ask` opens an owner
approval bound to that call. Right before listing, the tool reads the policy again and spends the
owner's grant, so each answer covers one listing. `POLICY_NAMED_TOOL_NAMES` in
`mastra/AkeruTools.ts` names the tools that use this path.

A delegated chat's principal is the parent bot acting for the owner. Delegation records do not
record other people yet.

The policy is stored on the bot as `permissionPolicy`. `bot.update` sets it, and `null` restores
the default. Projection rows keep it in `projection_bots.permission_policy_json` (migration 75), where
NULL means the default.

## Native OpenCode

Standard OpenCode runs its own tools on the legacy bridge and builds its permission rules from the
chat's mode alone, so it cannot apply a bot policy. Instead of mapping the policy onto OpenCode's
`bash`/`edit`/`webfetch` rules, which cannot tell `git push` from `pwd`, Akeru refuses to run what
it cannot enforce. Only the `opencode` driver is checked: Claude Agent also runs on the legacy
bridge, but it checks the policy on every tool call. `openCodePolicyBlock` checks the policy at session start and before every
OpenCode turn, so tightening a policy mid-session blocks the next turn. It refuses any policy rule
stricter than the default: an added `deny`, or an added `ask` in any mode. OpenCode can remember an
"always" grant for a command pattern, so even its own prompt is not a one-use owner approval. The error names the
rules and says to switch the bot to another provider or relax them. The default policy keeps
OpenCode's previous behavior, so its `write-outside: ask` is not enforced on OpenCode in Full access.

## Not yet wired

- Installed MCP connector tools and Composio tools still follow the per-tool rule in `Events.ts`:
  they ask unless the server marks the tool read-only. They do not read the bot policy yet.
- Routine runs still act as the owner principal rather than `schedule`.
- Channel senders are not principals yet; channel identity is tracked separately (AKR-234).
- No client screen edits the policy yet, and environment exports do not carry it.
