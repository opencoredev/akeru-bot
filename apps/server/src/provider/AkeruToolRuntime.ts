import type { AkeruToolResult } from "./tools/AkeruToolTypes.ts";
import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";
import { decodeAkeruRuntimeToolInput } from "./tools/AkeruToolInputs.ts";
import { RequestContext } from "@mastra/core/request-context";
import {
  AKERU_TOOL_CATALOG,
  type AkeruToolId,
  type AkeruToolReceipt,
  ThreadId,
  type BotPermissionPolicy,
  filterAkeruTools,
  AkeruDelegationContextTooLongError,
  AkeruDelegationProviderUnsupportedError,
} from "@akeru/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { BotApprovalCheck } from "@akeru/shared/botPermissions";
import { redactComputerScreenshot } from "../mcp/PreviewSnapshotRedaction.ts";
import {
  AKERU_MEMORY_TOOL_DESCRIPTION,
  type AkeruMemoryToolId,
} from "../memory/BotMemoryToolHandlers.ts";
import {
  type AkeruRuntimeToolDefinition,
  type AkeruToolRuntimeOptions,
  type AkeruToolRuntime,
  type AkeruToolSession,
  type AkeruRuntimeToolId,
  type AkeruToolExecution,
} from "./tools/AkeruToolTypes.ts";
import { requiredString, field } from "./tools/AkeruToolAuthorization.ts";
import { createAkeruNamedActionPermissions } from "./tools/AkeruNamedActionPermissions.ts";
import {
  DEFAULT_APPROVAL_TTL_MILLIS,
  LOCAL_ENVIRONMENT_ID,
  OWNER_PRINCIPAL,
  AkeruToolPermissionDeniedError,
  actionFingerprint,
  akeruRiskClass,
  createAkeruApprovalLedger,
  decideAkeruTool,
  initialPolicy,
} from "./tools/AkeruToolPermissions.ts";
import {
  workspaceForTool,
  toolsForWorkspace,
  BACKEND_NAMES,
  executable,
} from "./tools/AkeruWorkspaceTools.ts";

const isDelegationContextTooLong = Schema.is(AkeruDelegationContextTooLongError);

const isDelegationProviderUnsupported = Schema.is(AkeruDelegationProviderUnsupportedError);

const MEMORY_TOOL_DEFINITIONS = [
  { id: "memory", description: AKERU_MEMORY_TOOL_DESCRIPTION },
] as const satisfies ReadonlyArray<AkeruRuntimeToolDefinition>;

export function isMemoryToolId(toolId: string): toolId is AkeruMemoryToolId {
  return toolId === "memory";
}

export function createAkeruToolRuntime(options?: AkeruToolRuntimeOptions): AkeruToolRuntime {
  const sessions = new Map<string, AkeruToolSession>();
  /** The last policy each thread read, for synchronous checks. */
  const policies = new Map<string, BotPermissionPolicy>();

  const approvals = createAkeruApprovalLedger({
    environmentId: options?.environmentId ?? LOCAL_ENVIRONMENT_ID,
    ttlMillis: options?.approvalTtlMillis ?? DEFAULT_APPROVAL_TTL_MILLIS,
    clock: options?.clock ?? DateTime.nowUnsafe,
  });

  const clearApprovals = (threadId: string) => approvals.clearThread(threadId);

  const currentPolicy = async (threadId: string, session: AkeruToolSession) => {
    const policy = (await session.permissions?.readPolicy?.()) ?? initialPolicy(session);

    if (sessions.get(threadId) === session) policies.set(threadId, policy);

    return policy;
  };

  const namedActions = createAkeruNamedActionPermissions({
    sessions,
    policies,
    approvals,
    currentPolicy,
  });

  const emitReceipt = (
    input: AkeruToolExecution,
    phase: AkeruToolReceipt["phase"],
    details?: Pick<AkeruToolReceipt, "failureCode" | "summary">,
  ) => {
    try {
      options?.onReceipt?.({
        receiptId: input.toolCallId,
        toolId: input.toolId,
        phase,
        threadId: ThreadId.make(input.threadId),
        fatalToThread: false,
        createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
        ...details,
      });
    } catch {
      // Receipt observers must not change tool execution.
    }
  };

  const nonfatalToolFailureReceipt = (
    input: AkeruToolExecution,
    session: AkeruToolSession,
    cause: unknown,
    failureCode: NonNullable<AkeruToolReceipt["failureCode"]>,
    billedBotId?: AkeruToolSession["botId"],
  ): AkeruToolReceipt => {
    const summary = cause instanceof Error ? cause.message : String(cause);

    const receipt = {
      receiptId: input.toolCallId,
      toolId: input.toolId,
      phase: "failure",
      threadId: ThreadId.make(input.threadId),
      botId: session.botId,
      summary,
      failureCode,
      fatalToThread: false,
      ...(billedBotId ? { billedBotId } : {}),
      createdAt: options?.now?.() ?? DateTime.formatIso(DateTime.nowUnsafe()),
    } satisfies AkeruToolReceipt;

    emitReceipt(input, "failure", { failureCode, summary });

    return receipt;
  };

  const implementedTools = (session: AkeruToolSession) => {
    const tools = new Set<AkeruToolId>();

    if (session.workspace?.sandbox?.executeCommand) tools.add("Shell");

    if (session.workspace?.filesystem) tools.add("Read");

    if (session.workspace?.sandbox?.processes) tools.add("AwaitShell");

    if (session.workspace?.sandbox?.computer) tools.add("Screenshot");

    if (session.userComputerWorkspace?.sandbox?.executeCommand) {
      tools.add("ExternalShell");
    }

    if (session.userComputerWorkspace?.filesystem) {
      tools.add("ExternalRead");
    }

    if (session.userComputerWorkspace?.sandbox?.processes) {
      tools.add("AwaitExternalShell");
    }

    if (session.workspace?.filesystem && session.userComputerWorkspace?.filesystem) {
      tools.add("CopyToBox");
      tools.add("CopyFromBox");
    }

    if (options?.onUserActionRequired && session.workspace && session.botId && session.botName) {
      tools.add("request_box_help");
    }

    if (session.delegation) {
      if (session.delegation.create) tools.add("CreateAgent");

      if (session.delegation.check) tools.add("CheckAgent");
      tools.add("MessageAgent");

      if (session.delegation.stop) tools.add("StopAgent");
      tools.add("SendToAgent");
    }

    if (session.workers) {
      tools.add("Task");
      tools.add("CheckSubagent");
      tools.add("MessageSubagent");
      tools.add("StopSubagent");
    }

    if (session.channels) {
      tools.add("CreateChannel");
      tools.add("UpdateChannel");
    }

    if (session.sendToUser) tools.add("SendToUser");

    if (session.botId && session.botState) tools.add("UpdateBotProfile");

    if (session.reactToMessage) tools.add("ReactToMessage");

    for (const { id: toolId } of AKERU_TOOL_CATALOG) {
      if (!Object.hasOwn(session.catalogHandlers ?? {}, toolId)) continue;

      if (toolId === "GenerateImage") {
        const image = session.imageGeneration;

        if (image && !image.chatgptEnabled && !image.grokEnabled) continue;
      }

      tools.add(toolId);
    }

    if (session.delegation) {
      for (const toolId of tools) {
        if (!session.delegation.access.allowedToolIds.includes(toolId)) tools.delete(toolId);
      }
    }

    return tools;
  };

  const toolsForThread = (threadId: string) => {
    const session = sessions.get(threadId);

    if (!session) throw new Error(`Tool session '${threadId}' is not registered.`);
    const implemented = implementedTools(session);

    const workspaceTools = filterAkeruTools({
      capabilities: new Set(["bot-workspace", "user-computer"]),
      workspaceType: session.workspaceType,
      hasUserComputer: Boolean(session.userComputerWorkspace),
      localFullAccess: session.runtimeMode === "full-access",
      implementedTools: implemented,
      ...(session.delegation
        ? {
            delegationDepth: session.delegation.depth,
            activeDelegations: session.delegation.activeDelegations,
          }
        : {}),
      ...(session.workers ? { workerDepth: session.workers.depth } : {}),
    });

    return session.memoryHandlers
      ? [...workspaceTools, ...MEMORY_TOOL_DEFINITIONS]
      : workspaceTools;
  };

  const decodedGrantInput = (toolId: AkeruRuntimeToolId, input: AkeruToolExecution["input"]) =>
    decodeAkeruRuntimeToolInput(toolId, input, { approvalGrant: true }).input;

  const sessionFor = (threadId: string) => {
    const session = sessions.get(threadId);

    if (!session) throw new Error(`Tool session '${threadId}' is not registered.`);

    return session;
  };

  const availableTool = (threadId: string, toolId: AkeruRuntimeToolId) => {
    const tool = toolsForThread(threadId).find((candidate) => candidate.id === toolId);

    if (!tool) throw new Error(`Tool '${toolId}' is not available for this turn.`);

    return tool;
  };

  const grantSubject = (input: Omit<AkeruToolExecution, "approvalMode">) => {
    const session = sessionFor(input.threadId);
    const decodedInput = decodedGrantInput(input.toolId, input.input);

    return {
      threadId: input.threadId,
      toolCallId: input.toolCallId,
      session,
      action: actionFingerprint(input.toolId, decodedInput),
      riskClass: akeruRiskClass(session, input.toolId, decodedInput),
    };
  };

  return {
    registerSession: (threadId, session) => {
      clearApprovals(threadId);
      sessions.set(threadId, session);
      policies.set(threadId, initialPolicy(session));
    },
    unregisterSession: (threadId) => {
      sessions.delete(threadId);
      policies.delete(threadId);
      clearApprovals(threadId);
    },
    clearApprovals,
    toolsForThread,
    requiresApproval: async (threadId, toolId, input) => {
      const session = sessionFor(threadId);
      availableTool(threadId, toolId);

      const decision = decideAkeruTool({
        session,
        policy: await currentPolicy(threadId, session),
        toolId,
        decodedInput: decodeAkeruRuntimeToolInput(toolId, input).input,
      });

      return decision.requirement !== "none";
    },
    approvalRequirement: (threadId, toolId, input) => {
      try {
        const session = sessionFor(threadId);
        availableTool(threadId, toolId);
        const policy = policies.get(threadId) ?? initialPolicy(session);

        const { requirement } = decideAkeruTool({
          session,
          policy,
          toolId,
          decodedInput: decodeAkeruRuntimeToolInput(toolId, input).input,
        });

        // Only an explicit allow for this tool overrides the chat's permission mode.
        // A risk-class default leaves the mode in charge, so Supervised still asks.
        return requirement === "none" && policy.toolOverrides[toolId] !== "allow"
          ? "mode"
          : requirement;
      } catch {
        // The run repeats the check and reports the failure to the bot.
        return "blocked";
      }
    },
    openApproval: (input) => {
      try {
        approvals.open(grantSubject(input));
      } catch {
        // An undecodable or blocked call never runs, so it needs no binding.
      }
    },
    grantApproval: (input) =>
      sessions.has(input.threadId)
        ? approvals.answer({
            ...grantSubject(input),
            answeredBy: input.answeredBy ?? OWNER_PRINCIPAL,
          })
        : BotApprovalCheck.Rejected({ reason: "unknown-approval" }),
    grantModeApproval: (input) => {
      const session = sessions.get(input.threadId);

      if (!session) return BotApprovalCheck.Rejected({ reason: "unknown-approval" });
      const subject = grantSubject(input);
      let requirement: ReturnType<typeof decideAkeruTool>["requirement"];

      try {
        requirement = decideAkeruTool({
          session,
          policy: policies.get(input.threadId) ?? initialPolicy(session),
          toolId: input.toolId,
          decodedInput: decodedGrantInput(input.toolId, input.input),
        }).requirement;
      } catch (cause) {
        return BotApprovalCheck.Rejected({
          reason:
            cause instanceof AkeruToolPermissionDeniedError ? "denied-by-policy" : "not-approved",
        });
      }

      return approvals.grantByMode({ ...subject, requirement });
    },
    ...namedActions,
    execute: async (input) => {
      let failureCode: NonNullable<AkeruToolReceipt["failureCode"]> = "internal";
      emitReceipt(input, "start");
      let executionSession: AkeruToolSession | undefined;

      try {
        failureCode = "not_found";
        const session = sessions.get(input.threadId);

        if (!session) throw new Error(`Tool session '${input.threadId}' is not registered.`);
        executionSession = session;
        await options?.onToolStart?.(input, session);

        availableTool(input.threadId, input.toolId);

        failureCode = "validation";
        const execution = decodeAkeruRuntimeToolInput(input.toolId, input.input);
        const decoded = execution.input;
        failureCode = "denied";

        // The policy is read again here, so a permission revoked after approval blocks the run.
        const decision = decideAkeruTool({
          session,
          policy: await currentPolicy(input.threadId, session),
          toolId: input.toolId,
          decodedInput: decoded,
        });

        if (decision.requirement !== "none") {
          const rejection =
            input.approvalMode === "require-grant"
              ? approvals.consume({
                  threadId: input.threadId,
                  toolCallId: input.toolCallId,
                  session,
                  action: actionFingerprint(input.toolId, decoded),
                  verdict: decision.verdict,
                })
              : "not-approved";

          if (rejection === "not-approved") {
            throw new Error(`Tool '${input.toolId}' requires approval.`);
          }

          if (rejection) {
            throw new Error(`Tool '${input.toolId}' approval was refused (${rejection}).`);
          }
        }

        failureCode = "not_found";
        let result: AkeruToolResult;

        const catalogHandler =
          execution.toolId === "memory" ? undefined : session.catalogHandlers?.[execution.toolId];

        if (isMemoryToolId(input.toolId)) {
          const handler = session.memoryHandlers?.[input.toolId];

          if (!handler) throw new Error(`Tool '${input.toolId}' has no backend.`);
          failureCode = "internal";
          result = await handler({ ...input, toolId: input.toolId, input: decoded });
        } else if (catalogHandler) {
          failureCode = "internal";
          result = await catalogHandler({
            input: decoded,
            emitProgress: (summary, details) =>
              options?.onProgress?.({
                threadId: input.threadId,
                // SAFETY: Only catalog tools reach this callback; memory dispatch returns above.
                toolId: input.toolId as AkeruToolId,
                toolCallId: input.toolCallId,
                summary,
                ...details,
              }),
          });
        } else if (execution.toolId === "SendToAgent" || execution.toolId === "MessageAgent") {
          if (!session.delegation) throw new Error("Delegation is not available for this session.");
          const delegationInput = execution.input;
          failureCode = "internal";

          try {
            result = await session.delegation.send(delegationInput);
          } catch (cause) {
            if (isDelegationContextTooLong(cause)) failureCode = "validation";

            if (isDelegationProviderUnsupported(cause)) failureCode = "denied";

            return nonfatalToolFailureReceipt(
              input,
              session,
              cause,
              failureCode,
              delegationInput.botId,
            );
          }
        } else if (
          execution.toolId === "CreateAgent" ||
          execution.toolId === "CheckAgent" ||
          execution.toolId === "StopAgent"
        ) {
          if (!session.delegation) {
            throw new Error("Bot management is not available for this session.");
          }

          failureCode = "internal";
          let billedBotId = session.botId;

          try {
            if (execution.toolId === "CreateAgent") {
              if (!session.delegation.create) throw new Error("Bot creation is not available.");
              result = await session.delegation.create(execution.input);
            } else if (execution.toolId === "CheckAgent") {
              if (!session.delegation.check) throw new Error("Bot inspection is not available.");
              const checkInput = execution.input;
              billedBotId = checkInput.botId;
              result = await session.delegation.check(checkInput);
            } else {
              if (!session.delegation.stop) throw new Error("Bot cancellation is not available.");
              const stopInput = execution.input;
              billedBotId = stopInput.botId;
              result = await session.delegation.stop(stopInput);
            }
          } catch (cause) {
            return nonfatalToolFailureReceipt(input, session, cause, failureCode, billedBotId);
          }
        } else if (
          execution.toolId === "Task" ||
          execution.toolId === "CheckSubagent" ||
          execution.toolId === "MessageSubagent" ||
          execution.toolId === "StopSubagent"
        ) {
          if (!session.workers) throw new Error("Workers are not available for this session.");
          failureCode = "internal";

          try {
            result = await Match.value(execution).pipe(
              Match.when({ toolId: "Task" }, ({ input }) => session.workers!.spawn(input)),
              Match.when({ toolId: "CheckSubagent" }, ({ input }) => session.workers!.check(input)),
              Match.when({ toolId: "MessageSubagent" }, ({ input }) =>
                session.workers!.message(input),
              ),
              Match.orElse(({ input }) => session.workers!.stop(input)),
            );
          } catch (cause) {
            return nonfatalToolFailureReceipt(input, session, cause, failureCode);
          }
        } else if (execution.toolId === "CreateChannel" || execution.toolId === "UpdateChannel") {
          if (!session.channels || !session.botId) {
            throw new Error("Channel management is not available for this session.");
          }

          failureCode = "internal";

          try {
            const channelId =
              execution.toolId === "CreateChannel"
                ? await session.channels.create(execution.input)
                : await session.channels.update(execution.input);

            result = {
              receiptId: input.toolCallId,
              toolId: input.toolId,
              phase: "success",
              threadId: ThreadId.make(input.threadId),
              botId: session.botId,
              summary: `Channel '${channelId}' saved.`,
              fatalToThread: false,
              billedBotId: session.botId,
              createdAt: options?.now?.() ?? DateTime.formatIso(DateTime.nowUnsafe()),
            } satisfies AkeruToolReceipt;
          } catch (cause) {
            const summary = cause instanceof Error ? cause.message : String(cause);
            result = {
              receiptId: input.toolCallId,
              toolId: input.toolId,
              phase: "failure",
              threadId: ThreadId.make(input.threadId),
              botId: session.botId,
              summary,
              failureCode,
              fatalToThread: false,
              billedBotId: session.botId,
              createdAt: options?.now?.() ?? DateTime.formatIso(DateTime.nowUnsafe()),
            } satisfies AkeruToolReceipt;
            emitReceipt(input, "failure", { failureCode, summary });

            return result;
          }
        } else if (execution.toolId === "SendToUser") {
          if (!session.sendToUser) {
            throw new Error("User messaging is not available for this session.");
          }

          failureCode = "internal";

          try {
            result = await session.sendToUser(execution.input);
          } catch (cause) {
            const summary = cause instanceof Error ? cause.message : String(cause);
            result = {
              receiptId: input.toolCallId,
              toolId: input.toolId,
              phase: "failure",
              threadId: ThreadId.make(input.threadId),
              botId: session.botId,
              summary,
              failureCode,
              fatalToThread: false,
              createdAt: options?.now?.() ?? DateTime.formatIso(DateTime.nowUnsafe()),
            } satisfies AkeruToolReceipt;
            emitReceipt(input, "failure", { failureCode, summary });

            return result;
          }
        } else if (execution.toolId === "UpdateBotProfile") {
          if (!session.botId || !session.botState) {
            throw new Error("Bot profile management is not available for this session.");
          }

          failureCode = "internal";

          try {
            result = await session.botState.updateProfile(
              ThreadId.make(input.threadId),
              session.botId,
              input.toolCallId,
              execution.input,
            );
          } catch (cause) {
            const summary = cause instanceof Error ? cause.message : String(cause);
            result = {
              receiptId: input.toolCallId,
              toolId: input.toolId,
              phase: "failure",
              threadId: ThreadId.make(input.threadId),
              botId: session.botId,
              summary,
              failureCode,
              fatalToThread: false,
              billedBotId: session.botId,
              createdAt: options?.now?.() ?? DateTime.formatIso(DateTime.nowUnsafe()),
            } satisfies AkeruToolReceipt;
            emitReceipt(input, "failure", { failureCode, summary });

            return result;
          }
        } else if (execution.toolId === "ReactToMessage") {
          if (!session.reactToMessage) {
            throw new Error("Message reactions are not available for this session.");
          }

          failureCode = "internal";
          result = await session.reactToMessage(execution.input, input.toolCallId);
        } else if (input.toolId === "CopyToBox" || input.toolId === "CopyFromBox") {
          const source =
            input.toolId === "CopyToBox" ? session.userComputerWorkspace : session.workspace;

          const destination =
            input.toolId === "CopyToBox" ? session.workspace : session.userComputerWorkspace;

          if (!source?.filesystem || !destination?.filesystem) {
            throw new Error("Both computer boundaries are required for file copy.");
          }

          const sourcePath = requiredString(decoded, "sourcePath");
          const destinationPath = requiredString(decoded, "destinationPath");
          failureCode = "internal";
          await destination.filesystem.writeFile(
            destinationPath,
            await source.filesystem.readFile(sourcePath),
            { recursive: true },
          );
          result = { sourcePath, destinationPath };
        } else if (input.toolId === "request_box_help") {
          if (!options?.onUserActionRequired || !session.botId || !session.botName) {
            throw new Error("Human handoff is not available for this session.");
          }

          failureCode = "internal";
          await options.onUserActionRequired({
            botId: session.botId,
            botName: session.botName,
            toolId: input.toolId,
            summary: requiredString(decoded, "message"),
            nextAction: "Open the bot workspace and complete the requested step.",
            target: requiredString(decoded, "reason"),
          });
          result = { requested: true };
        } else {
          const workspace = workspaceForTool(input.toolId, session);
          const backends = await toolsForWorkspace(workspace);

          const backendNames = Object.hasOwn(BACKEND_NAMES, input.toolId)
            ? // SAFETY: hasOwn limits the tool id to the backend mapping keys.
              BACKEND_NAMES[input.toolId as keyof typeof BACKEND_NAMES]
            : [];

          const backendName = backendNames.find((name) => executable(backends[name]));
          const backend = backendName ? backends[backendName] : undefined;

          if (!executable(backend)) throw new Error(`Tool '${input.toolId}' has no backend.`);

          const backendInput =
            input.toolId === "AwaitShell" || input.toolId === "AwaitExternalShell"
              ? { pid: requiredString(decoded, "handleId"), wait: true }
              : decoded;

          failureCode = "internal";
          result = await backend.execute(backendInput, {
            ...(workspace ? { workspace } : {}),
            requestContext: new RequestContext(),
            observe: {
              span: async <A>(_name: string, run: () => A | Promise<A>) => run(),
              log: () => undefined,
            },
          });
        }

        if (input.toolId === "Screenshot") {
          const mediaType = field(result, "mediaType");
          const data = field(result, "data");

          if (mediaType !== "image/png" || !Predicate.isString(data)) {
            throw new Error("Screenshot result is invalid.");
          }

          const redacted = redactComputerScreenshot({
            mediaType,
            data: Buffer.from(data, "base64"),
          });

          result = {
            ...(Predicate.isObject(result) ? result : {}),
            data: Buffer.from(redacted.data).toString("base64"),
          };
        }

        if (field(result, "phase") === "failure") {
          const summary = field(result, "summary");
          emitReceipt(input, "failure", {
            failureCode,
            summary: Predicate.isString(summary) ? summary : "Tool execution failed.",
          });

          return result;
        }

        emitReceipt(input, "success");

        return result;
      } catch (cause) {
        emitReceipt(input, "failure", { failureCode, summary: "Tool execution failed." });
        throw cause;
      } finally {
        if (executionSession) await options?.onToolFinish?.(input, executionSession);
      }
    },
  };
}

export {
  type AkeruRuntimeToolId,
  type AkeruRuntimeToolDefinition,
  type AkeruToolSession,
  type AkeruToolRuntimeOptions,
  type AkeruToolExecution,
  type AkeruToolRuntime,
} from "./tools/AkeruToolTypes.ts";

export { intersectDelegationAccess } from "./tools/AkeruToolAuthorization.ts";
