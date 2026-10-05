import type { OrchestrationThreadActivity, UserInputQuestion } from "@akeru/contracts";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import { parseQuestions } from "./pendingRequests.ts";

export interface AnsweredUserInputQuestion {
  readonly question: UserInputQuestion;
  readonly answers: ReadonlyArray<string>;
}

export interface AskedUserInput {
  readonly questions: ReadonlyArray<UserInputQuestion>;
  /** Answers the provider confirmed, keyed by question id. Null until it does. */
  readonly resolvedAnswers: ReadonlyMap<string, ReadonlyArray<string>> | null;
}

const ANSWER_MESSAGE_PREFIX = "user-input:";

const ResolvedAnswers = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Array(Schema.String)]),
);

const decodeResolvedAnswers = Schema.decodeUnknownOption(ResolvedAnswers);

/** Trims each answer and flattens multi-select picks. */
function trimResolvedAnswers(answers: typeof ResolvedAnswers.Type): Map<string, string[]> {
  return new Map(
    Object.entries(answers).map(([questionId, value]) => [
      questionId,
      [value]
        .flat()
        .map((entry) => entry.trim())
        .filter(Boolean),
    ]),
  );
}

/** Every question set a bot asked in this thread, keyed by request id. */
export function deriveAskedUserInputs(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyMap<string, AskedUserInput> {
  const asked = new Map<string, AskedUserInput>();

  for (const activity of activities) {
    const payload = activity.payload;

    if (!Predicate.isObject(payload) || !Predicate.isString(payload.requestId)) continue;

    if (activity.kind === "user-input.requested") {
      const questions = parseQuestions(payload.questions);

      if (questions.length > 0) asked.set(payload.requestId, { questions, resolvedAnswers: null });
    } else if (activity.kind === "user-input.resolved") {
      const existing = asked.get(payload.requestId);

      if (existing) {
        asked.set(payload.requestId, {
          ...existing,
          resolvedAnswers: Option.match(decodeResolvedAnswers(payload.answers), {
            onNone: () => null,
            onSome: trimResolvedAnswers,
          }),
        });
      }
    }
  }

  return asked;
}

/**
 * Pairs a submitted answer with the questions it answers. The server records the answer as a
 * user message with id `user-input:<threadId>:<requestId>` whose text is every answer on its own
 * line, so channels and older clients still read it as text. Returns null for any other message,
 * or when the answers no longer line up with the questions.
 */
export function answeredUserInputForMessage(
  message: { readonly id: string; readonly text: string },
  asked: ReadonlyMap<string, AskedUserInput>,
): ReadonlyArray<AnsweredUserInputQuestion> | null {
  if (!message.id.startsWith(ANSWER_MESSAGE_PREFIX)) return null;

  for (const [requestId, request] of asked) {
    if (!message.id.endsWith(`:${requestId}`)) continue;

    return (
      answersFromResolved(request.questions, request.resolvedAnswers) ??
      answersFromText(request.questions, message.text)
    );
  }

  return null;
}

function answersFromResolved(
  questions: ReadonlyArray<UserInputQuestion>,
  resolved: ReadonlyMap<string, ReadonlyArray<string>> | null,
): AnsweredUserInputQuestion[] | null {
  if (!resolved) return null;
  const paired: AnsweredUserInputQuestion[] = [];

  for (const question of questions) {
    const answers = resolved.get(question.id) ?? [];

    if (answers.length === 0) return null;
    paired.push({ question, answers });
  }

  return paired;
}

/** Walks the answer lines in question order. A multi-select question takes every line that names one of its options. */
function answersFromText(
  questions: ReadonlyArray<UserInputQuestion>,
  text: string,
): AnsweredUserInputQuestion[] | null {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const paired: AnsweredUserInputQuestion[] = [];
  let cursor = 0;

  for (const question of questions) {
    const first = lines[cursor];

    if (first === undefined) return null;
    const answers = [first];
    cursor += 1;

    const labels = new Set(question.options.map((option) => option.label));

    if (question.multiSelect && labels.has(first)) {
      while (cursor < lines.length && labels.has(lines[cursor] ?? "")) {
        answers.push(lines[cursor] ?? "");
        cursor += 1;
      }
    }

    paired.push({ question, answers });
  }

  return cursor === lines.length ? paired : null;
}
