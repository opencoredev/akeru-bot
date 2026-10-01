import type {
  AkeruPluginSearchResult,
  MessageId,
  OrchestrationMessage,
  ScopedThreadRef,
} from "@akeru/contracts";
import type { ReplyPlaybackSession } from "@akeru/client-runtime/reply-playback";

import type { BotStepMeterData } from "@akeru/client-runtime/bot-step-usage";
import type { ChannelApprovalTarget } from "./ChannelSendApproval";
import type { Bot } from "./types";
import type { MessageReactionHandler } from "./useMessageReactionUpdater";

export type MessageReplyHandler = (messageId: MessageId, label: string, text: string) => void;

export interface PluginResultEntry {
  readonly id: string;
  readonly result: AkeruPluginSearchResult;
}

/** Props of the memoized assistant row, compared by `assistantRowPropsEqual`. */
export interface AssistantMessageRowProps {
  readonly message: OrchestrationMessage;
  /** The replying bot, or null when it is no longer available. */
  readonly author: Pick<Bot, "avatar" | "name"> | null;
  readonly testId: string;
  readonly arrived?: boolean;
  /** First reply in a run from the same author: shows the avatar and name. */
  readonly startsGroup: boolean;
  readonly cwd: string | undefined;
  readonly threadRef: ScopedThreadRef | undefined;
  readonly stepMeter: BotStepMeterData | undefined;
  readonly pluginResults: ReadonlyArray<PluginResultEntry> | undefined;
  readonly currentPersonId: string | null | undefined;
  readonly playback: ReplyPlaybackSession | null;
  /** Changes when the playback context changes, so the read-aloud action is recomputed. */
  readonly playbackKey: string | null | undefined;
  readonly channelApproval: ChannelApprovalTarget | null;
  readonly onReply: MessageReplyHandler;
  /** Null while the chat has no linked thread to react in. */
  readonly onReactionChange: MessageReactionHandler | null;
}

function shallowEqual<T extends object>(a: T | null | undefined, b: T | null | undefined) {
  if (a === b) return true;

  if (!a || !b) return false;
  const keys = Object.keys(a) as (keyof T)[];

  return keys.length === Object.keys(b).length && keys.every((key) => Object.is(a[key], b[key]));
}

function stepMetersEqual(a: BotStepMeterData | undefined, b: BotStepMeterData | undefined) {
  if (a === b) return true;

  if (!a || !b) return false;

  return (
    a.tokens === b.tokens &&
    a.costUsd === b.costUsd &&
    a.hardStopReached === b.hardStopReached &&
    shallowEqual(a.engine, b.engine)
  );
}

function pluginResultsEqual(
  a: ReadonlyArray<PluginResultEntry> | undefined,
  b: ReadonlyArray<PluginResultEntry> | undefined,
) {
  if (a === b) return true;

  if (!a || !b || a.length !== b.length) return false;

  return a.every((entry, index) => entry.id === b[index]?.id && entry.result === b[index]?.result);
}

export function assistantRowPropsEqual(
  previous: AssistantMessageRowProps,
  next: AssistantMessageRowProps,
) {
  const keys = Object.keys(next) as (keyof AssistantMessageRowProps)[];

  if (keys.length !== Object.keys(previous).length) return false;

  return keys.every((key) => {
    switch (key) {
      case "stepMeter":
        return stepMetersEqual(previous.stepMeter, next.stepMeter);
      case "pluginResults":
        return pluginResultsEqual(previous.pluginResults, next.pluginResults);
      case "channelApproval":
        return shallowEqual(previous.channelApproval, next.channelApproval);
      default:
        return Object.is(previous[key], next[key]);
    }
  });
}
