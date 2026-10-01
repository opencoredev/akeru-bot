import { type ProviderEvent, type ProviderRuntimeEvent, ThreadId } from "@akeru/contracts";
import * as EffectCodexSchema from "effect-codex-app-server/schema";
import { describeMcpElicitation } from "./CodexMcpElicitation.ts";
import {
  ApprovalDecisionPayload,
  readPayload,
  toRequestTypeFromMethod,
  toRequestTypeFromKind,
  toUserInputQuestions,
} from "./CodexCanonicalMapping.ts";
import { runtimeEventBase } from "./CodexEventIdentity.ts";

export function mapCodexRequestEvents(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> | undefined {
  if (event.kind === "error") {
    if (!event.message) {
      return [];
    }

    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "runtime.error",
        payload: {
          message: event.message,
          class: "provider_error",
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.kind === "request") {
    if (event.method === "item/tool/requestUserInput") {
      const payload =
        readPayload(EffectCodexSchema.ServerRequest__ToolRequestUserInputParams, event.payload) ??
        readPayload(EffectCodexSchema.ToolRequestUserInputParams, event.payload);

      const questions = payload ? toUserInputQuestions(payload.questions) : undefined;

      if (!questions) {
        return [];
      }

      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "user-input.requested",
          payload: {
            questions,
          },
        },
      ];
    }

    const elicitation =
      event.method === "mcpServer/elicitation/request"
        ? readPayload(EffectCodexSchema.McpServerElicitationRequestParams, event.payload)
        : undefined;

    const elicitationApproval = elicitation ? describeMcpElicitation(elicitation) : undefined;

    const detail = (() => {
      switch (event.method) {
        case "item/commandExecution/requestApproval": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__CommandExecutionRequestApprovalParams,
            event.payload,
          );

          return payload?.command ?? payload?.reason ?? undefined;
        }

        case "item/fileChange/requestApproval": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__FileChangeRequestApprovalParams,
            event.payload,
          );

          return payload?.reason ?? undefined;
        }

        case "mcpServer/elicitation/request":
          return elicitation?.message;
        case "applyPatchApproval": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__ApplyPatchApprovalParams,
            event.payload,
          );

          return payload?.reason ?? undefined;
        }

        case "execCommandApproval": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__ExecCommandApprovalParams,
            event.payload,
          );

          return payload?.reason ?? payload?.command.join(" ");
        }

        case "item/tool/call": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__DynamicToolCallParams,
            event.payload,
          );

          return payload?.tool ?? undefined;
        }

        default:
          return undefined;
      }
    })();

    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.opened",
        payload: {
          requestType: toRequestTypeFromMethod(event.method),
          ...(detail ? { detail } : {}),
          ...(elicitationApproval
            ? {
                appName: elicitationApproval.appName,
                options: elicitationApproval.options,
              }
            : {}),
        },
      },
    ];
  }

  if (event.method === "item/requestApproval/decision" && event.requestId) {
    const payload = readPayload(ApprovalDecisionPayload, event.payload);

    const requestType =
      event.requestKind !== undefined
        ? toRequestTypeFromKind(event.requestKind)
        : toRequestTypeFromMethod(event.method);

    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.resolved",
        payload: {
          requestType,
          ...(payload ? { decision: payload.decision } : {}),
          ...(event.payload !== undefined ? { resolution: event.payload } : {}),
        },
      },
    ];
  }

  return undefined;
}
