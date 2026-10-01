interface RecentThreadTitleContext {
  readonly context: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly truncated: boolean;
}

interface ThreadTitleContext {
  readonly message: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}

import { type ChatAttachment } from "@akeru/contracts";
import {
  MAX_FIRST_USER_TITLE_CONTEXT_CHARS,
  FIRST_USER_CONTEXT_TRUNCATION_MARKER,
  MAX_THREAD_TITLE_CONTEXT_CHARS,
  MAX_REGENERATION_ATTACHMENTS,
  THREAD_TITLE_CONTEXT_TRUNCATION_MARKER,
} from "./Fields.ts";

export type ThreadTitleMessage = {
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
};

export function formatThreadTitleSection(message: ThreadTitleMessage): string | undefined {
  if (message.role === "system") {
    return undefined;
  }

  const text = message.text.trim();

  const attachmentSummary = (message.attachments ?? [])
    .map((attachment) => attachment.name)
    .join(", ");

  const contents = [
    ...(text.length > 0 ? [text] : []),
    ...(attachmentSummary.length > 0 ? [`[Attachments: ${attachmentSummary}]`] : []),
  ].join("\n");

  return contents.length > 0 ? `${message.role.toUpperCase()}:\n${contents}` : undefined;
}

export function limitFirstUserSection(section: string): string {
  if (section.length <= MAX_FIRST_USER_TITLE_CONTEXT_CHARS) {
    return section;
  }

  return `${section.slice(
    0,
    MAX_FIRST_USER_TITLE_CONTEXT_CHARS - FIRST_USER_CONTEXT_TRUNCATION_MARKER.length,
  )}${FIRST_USER_CONTEXT_TRUNCATION_MARKER}`;
}

export function collectRecentThreadTitleContext(
  messages: ReadonlyArray<ThreadTitleMessage>,
  maxChars: number,
): RecentThreadTitleContext {
  let context = "";
  let truncated = false;
  const retainedAttachments: Array<ChatAttachment> = [];

  for (const message of messages.toReversed()) {
    const section = formatThreadTitleSection(message);

    if (section === undefined) {
      continue;
    }

    const separator = context.length > 0 ? "\n\n" : "";
    const available = maxChars - context.length - separator.length;

    if (section.length > available) {
      if (available > 0) {
        context = `${section.slice(-available)}${separator}${context}`;
        retainedAttachments.unshift(...(message.attachments ?? []));
      }

      truncated = true;
      break;
    }

    context = `${section}${separator}${context}`;
    retainedAttachments.unshift(...(message.attachments ?? []));
  }

  return { context, attachments: retainedAttachments, truncated };
}

export function formatThreadTitleContext(
  messages: ReadonlyArray<ThreadTitleMessage>,
): ThreadTitleContext {
  const recent = collectRecentThreadTitleContext(messages, MAX_THREAD_TITLE_CONTEXT_CHARS);

  if (!recent.truncated) {
    return {
      message: recent.context,
      attachments: recent.attachments.slice(-MAX_REGENERATION_ATTACHMENTS),
    };
  }

  const firstUserMessage = messages.find(
    (message) => message.role === "user" && formatThreadTitleSection(message),
  );

  const firstUserSection = firstUserMessage
    ? formatThreadTitleSection(firstUserMessage)
    : undefined;

  if (!firstUserMessage || !firstUserSection) {
    return {
      message: `${THREAD_TITLE_CONTEXT_TRUNCATION_MARKER}${recent.context}`,
      attachments: recent.attachments.slice(-MAX_REGENERATION_ATTACHMENTS),
    };
  }

  const pinnedSection = limitFirstUserSection(firstUserSection);

  const recentContextBudget =
    MAX_THREAD_TITLE_CONTEXT_CHARS -
    pinnedSection.length -
    "\n\n".length -
    THREAD_TITLE_CONTEXT_TRUNCATION_MARKER.length;

  const retainedRecent = collectRecentThreadTitleContext(messages, recentContextBudget);
  const pinnedAttachment = firstUserMessage.attachments?.[0];

  const recentAttachments = retainedRecent.attachments.filter(
    (attachment) => attachment.id !== pinnedAttachment?.id,
  );

  return {
    message: `${pinnedSection}\n\n${THREAD_TITLE_CONTEXT_TRUNCATION_MARKER}${retainedRecent.context}`,
    attachments: [
      ...(pinnedAttachment ? [pinnedAttachment] : []),
      ...recentAttachments.slice(
        -(MAX_REGENERATION_ATTACHMENTS - (pinnedAttachment === undefined ? 0 : 1)),
      ),
    ],
  };
}
