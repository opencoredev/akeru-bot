import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  type ProjectionSnapshotDependencies,
  ProjectionProjectDbRowSchema,
} from "../ProjectionSnapshotRows.ts";

export function makeProjectIdentity({
  repositoryIdentityResolver,
}: Pick<ProjectionSnapshotDependencies, "repositoryIdentityResolver">) {
  const repositoryIdentityResolutionConcurrency = 4;

  const resolveRepositoryIdentitiesForProjects = Effect.fn(
    "ProjectionSnapshotQuery.resolveRepositoryIdentitiesForProjects",
  )(function* (
    projectRows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionProjectDbRowSchema>>,
    options?: {
      readonly includeDeleted?: boolean;
    },
  ) {
    const filteredProjectRows =
      options?.includeDeleted === true
        ? projectRows
        : projectRows.filter((row) => row.deletedAt === null);
    const uniqueWorkspaceRoots = [...new Set(filteredProjectRows.map((row) => row.workspaceRoot))];
    const repositoryIdentityByWorkspaceRoot = new Map(
      yield* Effect.forEach(
        uniqueWorkspaceRoots,
        (workspaceRoot) =>
          repositoryIdentityResolver
            .resolve(workspaceRoot)
            .pipe(Effect.map((identity) => [workspaceRoot, identity] as const)),
        { concurrency: repositoryIdentityResolutionConcurrency },
      ),
    );

    return new Map(
      filteredProjectRows.map((row) => [
        row.projectId,
        repositoryIdentityByWorkspaceRoot.get(row.workspaceRoot) ?? null,
      ]),
    );
  });
  return { repositoryIdentityResolutionConcurrency, resolveRepositoryIdentitiesForProjects };
}
