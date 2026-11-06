import {
  DEFAULT_BOT_PERMISSION_POLICY,
  type BotActionPrincipal,
  type BotId,
  type OrchestrationBot,
} from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { AkeruToolPermissions } from "../../tools/AkeruToolTypes.ts";
import type { SessionLifecycleDependencies } from "./SessionLifecycleDependencies.ts";

/**
 * The principal and policy for one bot session. A delegated chat acts for the
 * parent bot, which carries the owner who started the work: delegation records
 * do not track other people yet.
 */
export function toolPermissionsFor(
  deps: Pick<SessionLifecycleDependencies, "projectionSnapshotQuery" | "runPromise">,
  input: {
    readonly bot: OrchestrationBot | undefined;
    readonly botId: BotId | null;
    readonly parentBotId: BotId | undefined;
  },
): AkeruToolPermissions {
  const principal: BotActionPrincipal = input.parentBotId
    ? { kind: "bot", botId: input.parentBotId, onBehalfOf: { kind: "owner" } }
    : { kind: "owner" };

  const policy = input.bot?.permissionPolicy ?? DEFAULT_BOT_PERMISSION_POLICY;
  const getBotById = Option.getOrUndefined(deps.projectionSnapshotQuery)?.getBotById;
  const botId = input.botId;

  if (!getBotById || !botId) return { principal, policy };

  return {
    principal,
    policy,
    readPolicy: () =>
      deps.runPromise(
        getBotById(botId).pipe(
          Effect.map(
            (bot) => Option.getOrUndefined(bot)?.permissionPolicy ?? DEFAULT_BOT_PERMISSION_POLICY,
          ),
        ),
      ),
  };
}
