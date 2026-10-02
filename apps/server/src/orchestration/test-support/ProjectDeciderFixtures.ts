import { EventId, MessageId, ProjectId } from "@akeru/contracts";

export const asEventId = (value: string): EventId => EventId.make(value);

export const asProjectId = (value: string): ProjectId => ProjectId.make(value);

export const asMessageId = (value: string): MessageId => MessageId.make(value);
