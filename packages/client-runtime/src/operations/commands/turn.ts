import * as Effect from "effect/Effect";
import {
  type CommandInput,
  type CommandEffect,
  timestampedCommandMetadata,
  dispatch,
} from "./dispatch.ts";

export type StartThreadTurnInput = CommandInput<"thread.turn.start">;

export type ResumeThreadTurnInput = CommandInput<"thread.turn.resume">;

export type AppendVoiceTranscriptInput = CommandInput<"thread.voice-transcript.append">;

export type InterruptThreadTurnInput = CommandInput<"thread.turn.interrupt">;

export type RespondToThreadApprovalInput = CommandInput<"thread.approval.respond">;

export type RespondToThreadUserInputInput = CommandInput<"thread.user-input.respond">;

export type StopThreadSessionInput = CommandInput<"thread.session.stop">;

export const startThreadTurn: (input: StartThreadTurnInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.startThreadTurn",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);

  return yield* dispatch({
    ...input,
    timezone: input.timezone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"),
    type: "thread.turn.start",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const resumeThreadTurn: (input: ResumeThreadTurnInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.resumeThreadTurn",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);

  return yield* dispatch({
    ...input,
    type: "thread.turn.resume",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const appendVoiceTranscript: (input: AppendVoiceTranscriptInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.appendVoiceTranscript")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);

    return yield* dispatch({
      ...input,
      type: "thread.voice-transcript.append",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

export const interruptThreadTurn: (input: InterruptThreadTurnInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.interruptThreadTurn",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);

  return yield* dispatch({
    ...input,
    type: "thread.turn.interrupt",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});

export const respondToThreadApproval: (input: RespondToThreadApprovalInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.respondToThreadApproval")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);

    return yield* dispatch({
      ...input,
      type: "thread.approval.respond",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

export const respondToThreadUserInput: (input: RespondToThreadUserInputInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.respondToThreadUserInput")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);

    return yield* dispatch({
      ...input,
      type: "thread.user-input.respond",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });

export const stopThreadSession: (input: StopThreadSessionInput) => CommandEffect = Effect.fn(
  "EnvironmentCommands.stopThreadSession",
)(function* (input) {
  const metadata = yield* timestampedCommandMetadata(input);

  return yield* dispatch({
    ...input,
    type: "thread.session.stop",
    commandId: metadata.commandId,
    createdAt: metadata.createdAt,
  });
});
