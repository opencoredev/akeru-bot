import * as Schema from "effect/Schema";
import { type ToolsInput, Agent } from "@mastra/core/agent";
import { type Tool, noopObserve } from "@mastra/core/tools";
import { RequestContext } from "@mastra/core/request-context";
import * as Predicate from "effect/Predicate";
import type { AkeruMastraHarness } from "../AkeruMastraHarness.ts";

type ExecutableTool = Pick<Tool, "execute" | "requireApproval" | "needsApprovalFn">;

function isExecutableTool(value: unknown): value is ExecutableTool {
  return Predicate.isObject(value) && Predicate.isFunction(value.execute);
}

const decodeExecutableTool = Schema.decodeUnknownSync(
  Schema.declare<ExecutableTool>(isExecutableTool),
);

type ToolContext = Parameters<NonNullable<Tool["execute"]>>[1];

type TestToolContext = Omit<Partial<ToolContext>, "agent"> & {
  agent?: Partial<NonNullable<ToolContext["agent"]>>;
};

export function probeTool(input: ToolsInput[string] | undefined) {
  const value = decodeExecutableTool(input);

  return {
    requireApproval: value.requireApproval,
    needsApprovalFn: (input: Parameters<NonNullable<Tool["needsApprovalFn"]>>[0]) => {
      if (!value.needsApprovalFn) throw new Error("Expected a tool approval predicate.");

      return value.needsApprovalFn(input);
    },
    execute: (
      input: Parameters<NonNullable<Tool["execute"]>>[0],
      context: TestToolContext = {},
    ) => {
      const { agent, ...rest } = context;

      return value.execute!(input, {
        observe: noopObserve,
        requestContext: new RequestContext(),
        ...rest,
        ...(agent
          ? {
              agent: {
                agentId: "test-agent",
                toolCallId: "test-call",
                messages: [],
                suspend: async () => {},
                ...agent,
              },
            }
          : {}),
      });
    },
  };
}

export function harnessAgent(harness: AkeruMastraHarness) {
  const controller = harness.controller;

  if (
    !("config" in controller) ||
    !Predicate.isObject(controller.config) ||
    !(controller.config.agent instanceof Agent)
  ) {
    throw new Error("Expected the harness controller's agent.");
  }

  return controller.config.agent;
}
