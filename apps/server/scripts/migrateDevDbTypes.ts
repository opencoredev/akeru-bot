import * as Schema from "effect/Schema";



export class MigrateDevDbNotInWorktreeError extends Schema.TaggedErrorClass<MigrateDevDbNotInWorktreeError>()(
  "MigrateDevDbNotInWorktreeError",
  {},
) {
  override get message(): string {
    return "Not inside a linked git worktree. Pass --base-dir to target an isolated .akeru directory.";
  }
}

export class MigrateDevDbSharedHomeError extends Schema.TaggedErrorClass<MigrateDevDbSharedHomeError>()(
  "MigrateDevDbSharedHomeError",
  {},
) {
  override get message(): string {
    return "Refusing to rebuild the shared ~/.akeru database. Use an isolated --base-dir.";
  }
}

export class MigrateDevDbSourceMissingError extends Schema.TaggedErrorClass<MigrateDevDbSourceMissingError>()(
  "MigrateDevDbSourceMissingError",
  {
    sourcePath: Schema.String,
  },
) {
  override get message(): string {
    return `Source database does not exist at '${this.sourcePath}'.`;
  }
}

export class MigrateDevDbSourceIsDestinationError extends Schema.TaggedErrorClass<MigrateDevDbSourceIsDestinationError>()(
  "MigrateDevDbSourceIsDestinationError",
  {
    sourcePath: Schema.String,
  },
) {
  override get message(): string {
    return `Source database '${this.sourcePath}' resolves to a path this command rewrites. Pick a different --source or --base-dir.`;
  }
}

export class MigrateDevDbPhaseError extends Schema.TaggedErrorClass<MigrateDevDbPhaseError>()(
  "MigrateDevDbPhaseError",
  {
    phase: Schema.Literals(["snapshot", "prune", "compact", "migrate", "verify"]),
    databasePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `migrate-dev-db failed during ${this.phase} on '${this.databasePath}'.`;
  }
}

export interface RunMigrateDevDbInput {
  /** Isolated .akeru directory. Defaults to `<worktree>/.akeru` of the cwd. */
  readonly baseDir?: string | undefined;
  /** Source database. Defaults to `~/.akeru/userdata/state.sqlite`. */
  readonly source?: string | undefined;
  readonly projects: number;
  readonly threadsPerProject: number;
}

export interface RunMigrateDevDbOptions {
  /** Overridable for tests; the directory writes must never target. */
  readonly sharedHome?: string | undefined;
}
