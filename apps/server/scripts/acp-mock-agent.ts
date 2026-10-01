#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as Predicate from "effect/Predicate";
import * as NodeFS from "node:fs";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as EffectAcpAgent from "effect-acp/agent";
import * as AcpError from "effect-acp/errors";
import { requestLogPath as configuredRequestLogPath, emitLateUpdateAfterCancel, failLoadSession, emitLoadReplay, hangLoadSessionAfterReplay, delayLoadSessionAfterReplay, loadSessionDelayMs, failSetConfigOption, exitOnSetConfigOption, sessionId, cancelledSessions, writeJsonRpcNotification, configOptions, availableModels, modeState, grokAcpModels, modelState, scenarioState } from "./acpMockConfig.ts";
import { createPromptScenario } from "./acpMockPromptScenarios.ts";


const requestLogPath = configuredRequestLogPath;

const program = Effect.gen(function* () {
  const agent = yield* EffectAcpAgent.AcpAgent;

  yield* agent.handleInitialize((request) =>
    Effect.sync(() => {
      scenarioState.parameterizedModelPicker =
        request.clientCapabilities?._meta?.parameterizedModelPicker === true;
      return {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        // Grok advertises model state before any session exists; the provider
        // health check reads it from here without authenticating.
        _meta: { modelState: modelState() },
      };
    }),
  );

  yield* agent.handleAuthenticate(() => Effect.succeed({}));

  yield* agent.handleCreateSession(() =>
    Effect.succeed({
      sessionId,
      modes: modeState(),
      models: modelState(),
      configOptions: configOptions(),
    }),
  );

  const emitLoadReplayNotifications = (requestedSessionId: string) => {
    writeJsonRpcNotification("session/update", {
      _meta: { isReplay: true },
      sessionId: requestedSessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "replay-tool-1",
        title: "Replay tool",
        kind: "search",
        status: "completed",
      },
    });
    writeJsonRpcNotification("session/update", {
      _meta: { isReplay: true },
      sessionId: requestedSessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "replayed assistant text" },
      },
    });
  };

  yield* agent.handleLoadSession((request) =>
    Effect.gen(function* () {
      const requestedSessionId = String(request.sessionId ?? sessionId);
      if (failLoadSession) {
        return yield* AcpError.AcpRequestError.internalError("Mock load session failure");
      }
      if (hangLoadSessionAfterReplay || delayLoadSessionAfterReplay) {
        emitLoadReplayNotifications(requestedSessionId);
        yield* agent.client.sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "replay-tail" },
          },
        });
        yield* Effect.sleep(loadSessionDelayMs);
        return {
          modes: modeState(),
          models: modelState(),
          configOptions: configOptions(),
        };
      }
      if (emitLoadReplay) {
        emitLoadReplayNotifications(requestedSessionId);
      }
      yield* agent.client.sessionUpdate({
        sessionId: requestedSessionId,
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "replay" },
        },
      });
      return {
        modes: modeState(),
        models: modelState(),
        configOptions: configOptions(),
      };
    }),
  );

  yield* agent.handleSetSessionModel((request) =>
    Effect.gen(function* () {
      if (!grokAcpModels.some((model) => model.modelId === request.modelId)) {
        return yield* AcpError.AcpRequestError.invalidParams(
          `Unknown mock model id: ${request.modelId}`,
          {
            method: "session/set_model",
            params: request,
          },
        );
      }
      scenarioState.currentModelId = request.modelId;
      return {};
    }),
  );

  yield* agent.handleSetSessionConfigOption((request) =>
    Effect.gen(function* () {
      if (exitOnSetConfigOption) {
        return yield* Effect.sync(() => {
          process.exit(7);
        });
      }
      if (failSetConfigOption) {
        return yield* AcpError.AcpRequestError.invalidParams(
          "Mock invalid params for session/set_config_option",
          {
            method: "session/set_config_option",
            params: request,
          },
        );
      }
      if (request.configId === "mode" && Predicate.isString(request.value)) {
        scenarioState.currentModeId = request.value;
      }
      if (request.configId === "model" && Predicate.isString(request.value)) {
        scenarioState.currentModelId = request.value;
      }
      if (request.configId === "reasoning" && Predicate.isString(request.value)) {
        scenarioState.currentReasoning = request.value;
      }
      if (request.configId === "context" && Predicate.isString(request.value)) {
        scenarioState.currentContext = request.value;
      }
      if (request.configId === "fast") {
        scenarioState.currentFast = request.value === true || request.value === "true";
      }
      return {
        configOptions: configOptions(),
      };
    }),
  );

  yield* agent.handleCancel(({ sessionId }) =>
    Effect.gen(function* () {
      const cancelledSessionId = String(sessionId ?? "mock-session-1");
      cancelledSessions.add(cancelledSessionId);
      if (emitLateUpdateAfterCancel) {
        yield* Effect.sleep("50 millis");
        yield* Effect.sync(() => {
          writeJsonRpcNotification("session/update", {
            sessionId: cancelledSessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "late after cancel" },
            },
          });
        });
      }
    }),
  );
yield* agent.handlePrompt(createPromptScenario(scenarioState, agent));

  yield* agent.handleUnknownExtRequest((method, params) => {
    if (method === "cursor/list_available_models") {
      return Effect.succeed({
        models: availableModels(),
      });
    }

    if (method !== "session/mode/set") {
      return Effect.fail(AcpError.AcpRequestError.methodNotFound(method));
    }

    const nextModeId =
      Predicate.isObjectOrArray(params) &&
      params !== null &&
      "modeId" in params &&
      Predicate.isString(params.modeId)
        ? params.modeId
        : Predicate.isObjectOrArray(params) &&
            params !== null &&
            "mode" in params &&
            Predicate.isString(params.mode)
          ? params.mode
          : undefined;
    const requestedSessionId =
      Predicate.isObjectOrArray(params) &&
      params !== null &&
      "sessionId" in params &&
      Predicate.isString(params.sessionId)
        ? params.sessionId
        : sessionId;

    if (Predicate.isString(nextModeId) && nextModeId.trim()) {
      scenarioState.currentModeId = nextModeId.trim();
      return agent.client
        .sessionUpdate({
          sessionId: requestedSessionId,
          update: {
            sessionUpdate: "current_mode_update",
            currentModeId: scenarioState.currentModeId,
          },
        })
        .pipe(Effect.as({}));
    }

    return Effect.succeed({});
  });

  return yield* Effect.never;
}).pipe(
  Effect.provide(
    EffectAcpAgent.layerStdio(
      requestLogPath
        ? {
            logIncoming: true,
            logger: (event) => {
              if (event.direction !== "incoming" || event.stage !== "raw") {
                return Effect.void;
              }
              if (!Predicate.isString(event.payload)) {
                return Effect.void;
              }
              const payload = event.payload;
              return Effect.sync(() => {
                NodeFS.appendFileSync(
                  requestLogPath,
                  payload.endsWith("\n") ? payload : `${payload}\n`,
                  "utf8",
                );
              });
            },
          }
        : {},
    ),
  ),
  Effect.scoped,
  Effect.provide(NodeServices.layer),
);


NodeRuntime.runMain(program);
