import { isGroupBotMember } from "@t3tools/contracts";
import type {
  BotId,
  GroupId,
  OrchestrationBot,
  McpServer,
  McpServerId,
  OrchestrationCommand,
  OrchestrationGroup,
  OrchestrationProject,
  OrchestrationReadModel,
  OrchestrationThread,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Effect from "effect/Effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import type { OrchestrationDispatchActor } from "./Services/OrchestrationEngine.ts";

function invariantError(commandType: string, detail: string): OrchestrationCommandInvariantError {
  return new OrchestrationCommandInvariantError({
    commandType,
    detail,
  });
}

export function findThreadById(
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationThread | undefined {
  return readModel.threads.find((thread) => thread.id === threadId);
}

export function findProjectById(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): OrchestrationProject | undefined {
  return readModel.projects.find((project) => project.id === projectId);
}

export function findBotById(
  readModel: OrchestrationReadModel,
  botId: BotId,
): OrchestrationBot | undefined {
  return readModel.bots.find((bot) => bot.id === botId);
}

export function findGroupById(
  readModel: OrchestrationReadModel,
  groupId: GroupId,
): OrchestrationGroup | undefined {
  return readModel.groups.find((group) => group.id === groupId);
}

export function findMcpServerById(
  readModel: OrchestrationReadModel,
  mcpServerId: McpServerId,
): McpServer | undefined {
  return readModel.mcpServers?.find((mcpServer) => mcpServer.id === mcpServerId);
}

export function listThreadsByProjectId(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): ReadonlyArray<OrchestrationThread> {
  return readModel.threads.filter((thread) => thread.projectId === projectId);
}

export function requireProject(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<OrchestrationProject, OrchestrationCommandInvariantError> {
  const project = findProjectById(input.readModel, input.projectId);
  if (project) {
    return Effect.succeed(project);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireProjectAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findProjectById(input.readModel, input.projectId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireActiveProjectWorkspaceRootAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly workspaceRoot: string;
  readonly exceptProjectId?: ProjectId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const normalizedWorkspaceRoot = normalizeProjectPathForComparison(input.workspaceRoot);
  const existingProject = input.readModel.projects.find(
    (project) =>
      project.deletedAt === null &&
      normalizeProjectPathForComparison(project.workspaceRoot) === normalizedWorkspaceRoot &&
      project.id !== input.exceptProjectId,
  );
  if (existingProject === undefined) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Active project '${existingProject.id}' already exists for workspace root '${normalizedWorkspaceRoot}'.`,
    ),
  );
}

export function requireBot(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly botId: BotId;
}): Effect.Effect<OrchestrationBot, OrchestrationCommandInvariantError> {
  const bot = findBotById(input.readModel, input.botId);
  return bot
    ? Effect.succeed(bot)
    : Effect.fail(
        invariantError(
          input.command.type,
          `Bot '${input.botId}' does not exist for command '${input.command.type}'.`,
        ),
      );
}

export function requireBotAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly botId: BotId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  return findBotById(input.readModel, input.botId)
    ? Effect.fail(
        invariantError(
          input.command.type,
          `Bot '${input.botId}' already exists and cannot be created twice.`,
        ),
      )
    : Effect.void;
}

export function requireBotArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly botId: BotId;
}): Effect.Effect<OrchestrationBot, OrchestrationCommandInvariantError> {
  return requireBot(input).pipe(
    Effect.flatMap((bot) =>
      bot.archivedAt !== null
        ? Effect.succeed(bot)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Bot '${input.botId}' is not archived for command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireMcpServer(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly mcpServerId: McpServerId;
}): Effect.Effect<McpServer, OrchestrationCommandInvariantError> {
  const mcpServer = findMcpServerById(input.readModel, input.mcpServerId);
  if (mcpServer) {
    return Effect.succeed(mcpServer);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `MCP server '${input.mcpServerId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireBotNotArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly botId: BotId;
}): Effect.Effect<OrchestrationBot, OrchestrationCommandInvariantError> {
  return requireBot(input).pipe(
    Effect.flatMap((bot) =>
      bot.archivedAt === null
        ? Effect.succeed(bot)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Bot '${input.botId}' is archived for command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireMcpServerAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly mcpServerId: McpServerId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findMcpServerById(input.readModel, input.mcpServerId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `MCP server '${input.mcpServerId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireGroup(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly groupId: GroupId;
}): Effect.Effect<OrchestrationGroup, OrchestrationCommandInvariantError> {
  const group = findGroupById(input.readModel, input.groupId);
  return group
    ? Effect.succeed(group)
    : Effect.fail(
        invariantError(
          input.command.type,
          `Group '${input.groupId}' does not exist for command '${input.command.type}'.`,
        ),
      );
}

function requireMutationActorAuthorized(input: {
  readonly group: OrchestrationGroup;
  readonly command: OrchestrationCommand;
  readonly actor: OrchestrationDispatchActor | undefined;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const actor = input.actor;
  if (
    actor === undefined ||
    actor.canManageGroups ||
    input.group.members.some(
      (member) => member.kind === "person" && member.personId === actor.personId,
    )
  ) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Person '${actor.personId}' is not a member of group '${input.group.id}'.`,
    ),
  );
}

export function requireGroupThreadCreateAuthorized(input: {
  readonly group: OrchestrationGroup;
  readonly command: Extract<OrchestrationCommand, { readonly type: "thread.create" }>;
  readonly actor: OrchestrationDispatchActor | undefined;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  return requireMutationActorAuthorized(input);
}

export function requireGroupOwnedThreadMutationAuthorized(input: {
  readonly readModel: OrchestrationReadModel;
  readonly thread: OrchestrationThread;
  readonly command: OrchestrationCommand;
  readonly actor: OrchestrationDispatchActor | undefined;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (input.thread.groupId == null) return Effect.void;
  const group = findGroupById(input.readModel, input.thread.groupId);
  if (!group) {
    return Effect.fail(
      invariantError(
        input.command.type,
        `Group '${input.thread.groupId}' does not exist for command '${input.command.type}'.`,
      ),
    );
  }
  return requireMutationActorAuthorized({ group, command: input.command, actor: input.actor });
}

export function requireGroupAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly groupId: GroupId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  return findGroupById(input.readModel, input.groupId)
    ? Effect.fail(
        invariantError(
          input.command.type,
          `Group '${input.groupId}' already exists and cannot be created twice.`,
        ),
      )
    : Effect.void;
}

export function requireGroupMember(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly groupId: GroupId;
  readonly botId: BotId;
}): Effect.Effect<OrchestrationBot, OrchestrationCommandInvariantError> {
  return Effect.gen(function* () {
    const group = yield* requireGroup(input);
    const member = group.members.find(
      (entry) => isGroupBotMember(entry) && entry.botId === input.botId,
    );
    if (!member) {
      return yield* Effect.fail(
        invariantError(
          input.command.type,
          `Bot '${input.botId}' is not a member of group '${input.groupId}'.`,
        ),
      );
    }
    return yield* requireBot(input);
  });
}

export function requireActiveGroupMember(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly groupId: GroupId;
  readonly botId: BotId;
}): Effect.Effect<OrchestrationBot, OrchestrationCommandInvariantError> {
  return requireGroupMember(input).pipe(
    Effect.flatMap((bot) =>
      bot.archivedAt === null
        ? Effect.succeed(bot)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Bot '${input.botId}' is archived and cannot respond for group '${input.groupId}'.`,
            ),
          ),
    ),
  );
}

export function requireThread(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  const thread = findThreadById(input.readModel, input.threadId);
  if (thread) {
    return Effect.succeed(thread);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireThreadArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt !== null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is not archived for command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadNotArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt === null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is already archived and cannot handle command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findThreadById(input.readModel, input.threadId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireNonNegativeInteger(input: {
  readonly commandType: OrchestrationCommand["type"];
  readonly field: string;
  readonly value: number;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (Number.isInteger(input.value) && input.value >= 0) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.commandType,
      `${input.field} must be an integer greater than or equal to 0.`,
    ),
  );
}
