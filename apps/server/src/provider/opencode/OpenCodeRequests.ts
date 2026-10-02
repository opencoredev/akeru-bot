import * as Predicate from "effect/Predicate";
import * as NodeURL from "node:url";
import type {
  ProviderUserInputAnswers,
  ChatAttachment,
  ProviderApprovalDecision,
  RuntimeMode,
} from "@akeru/contracts";
import {
  type FilePartInput,
  type PermissionRuleset,
  type QuestionAnswer,
  type QuestionRequest,
} from "@opencode-ai/sdk/v2";

export function openCodeQuestionId(
  index: number,
  question: QuestionRequest["questions"][number],
): string {
  const header = question.header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-");

  return header.length > 0 ? `question-${index}-${header}` : `question-${index}`;
}

export function toOpenCodeFileParts(input: {
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly resolveAttachmentPath: (attachment: ChatAttachment) => string | null;
}): Array<FilePartInput> {
  const parts: Array<FilePartInput> = [];

  for (const attachment of input.attachments ?? []) {
    const attachmentPath = input.resolveAttachmentPath(attachment);

    if (!attachmentPath) {
      continue;
    }

    parts.push({
      type: "file",
      mime: attachment.mimeType,
      filename: attachment.name,
      url: NodeURL.pathToFileURL(attachmentPath).href,
    });
  }

  return parts;
}

export function buildOpenCodePermissionRules(runtimeMode: RuntimeMode): PermissionRuleset {
  if (runtimeMode === "full-access") {
    return [{ permission: "*", pattern: "*", action: "allow" }];
  }

  // "Auto-accept edits" is documented as "auto-approve edits, ask before other
  // actions", so prompting for every edit ignores the mode the user picked.
  // "auto" is left asking on purpose: the docs say providers without an AI
  // reviewer, OpenCode among them, fall back to Supervised for that mode.
  const editAction = runtimeMode === "auto-accept-edits" ? "allow" : "ask";

  return [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "bash", pattern: "*", action: "ask" },
    { permission: "edit", pattern: "*", action: editAction },
    { permission: "webfetch", pattern: "*", action: "ask" },
    { permission: "websearch", pattern: "*", action: "ask" },
    { permission: "codesearch", pattern: "*", action: "ask" },
    { permission: "external_directory", pattern: "*", action: "ask" },
    { permission: "doom_loop", pattern: "*", action: "ask" },
    { permission: "question", pattern: "*", action: "allow" },
  ];
}

export function toOpenCodePermissionReply(
  decision: ProviderApprovalDecision,
): "once" | "always" | "reject" {
  switch (decision) {
    case "accept":
      return "once";
    case "acceptForSession":
      return "always";
    case "decline":
    case "cancel":
    default:
      return "reject";
  }
}

export function toOpenCodeQuestionAnswers(
  request: QuestionRequest,
  answers: ProviderUserInputAnswers,
): Array<QuestionAnswer> {
  return request.questions.map((question, index) => {
    const raw =
      answers[openCodeQuestionId(index, question)] ??
      answers[question.header] ??
      answers[question.question];

    if (Array.isArray(raw)) {
      return raw.filter((value): value is string => Predicate.isString(value));
    }

    if (Predicate.isString(raw)) {
      return raw.trim().length > 0 ? [raw] : [];
    }

    return [];
  });
}
