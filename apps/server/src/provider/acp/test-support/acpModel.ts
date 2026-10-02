import { type AcpToolCallState } from "../AcpRuntimeModel.ts";

export const toolCall = (detail: string | undefined, status?: AcpToolCallState["status"]) =>
  ({
    toolCallId: "tool-1",
    title: "Grok Tool",
    ...(status ? { status } : {}),
    ...(detail ? { detail } : {}),
    data: {},
  }) satisfies AcpToolCallState;
