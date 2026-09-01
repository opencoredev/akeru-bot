import * as Crypto from "effect/Crypto";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  type ApproveRoutineInput,
  type AssignRoutineSkillInput,
  type DeleteRoutineInput,
  type DraftRoutineInput,
  type EnableRoutineInput,
  type PauseRoutineInput,
  type RunRoutineInput,
  type UnassignRoutineSkillInput,
  approveRoutine,
  assignRoutineSkill,
  deleteRoutine,
  draftRoutine,
  enableRoutine,
  pauseRoutine,
  runRoutine,
  unassignRoutineSkill,
} from "../operations/commands.ts";
import { createAtomCommandScheduler, createEnvironmentCommand } from "./runtime.ts";

export type {
  ApproveRoutineInput,
  AssignRoutineSkillInput,
  DeleteRoutineInput,
  DraftRoutineInput,
  EnableRoutineInput,
  PauseRoutineInput,
  RunRoutineInput,
  UnassignRoutineSkillInput,
} from "../operations/commands.ts";

export function createRoutineEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { routineId: string } }) =>
      JSON.stringify([environmentId, "routine", input.routineId]),
  };

  const command = <Input extends { routineId: string }>(
    label: string,
    execute: (input: Input) => ReturnType<typeof draftRoutine>,
  ) => createEnvironmentCommand(runtime, { label, execute, scheduler, concurrency });

  return {
    draft: command("environment-data:commands:routine:draft", draftRoutine),
    approve: command("environment-data:commands:routine:approve", approveRoutine),
    enable: command("environment-data:commands:routine:enable", enableRoutine),
    pause: command("environment-data:commands:routine:pause", pauseRoutine),
    run: command("environment-data:commands:routine:run", runRoutine),
    delete: command("environment-data:commands:routine:delete", deleteRoutine),
    assignSkill: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:routine:skill:assign",
      execute: (input: AssignRoutineSkillInput) => assignRoutineSkill(input),
      scheduler,
    }),
    unassignSkill: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:routine:skill:unassign",
      execute: (input: UnassignRoutineSkillInput) => unassignRoutineSkill(input),
      scheduler,
    }),
  };
}
