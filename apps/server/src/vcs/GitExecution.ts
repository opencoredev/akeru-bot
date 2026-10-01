import { collectOutput } from "./GitCoreHelpers.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { GitCommandError } from "@akeru/contracts";
import { gitCommandDuration, gitCommandsTotal, withMetrics } from "../observability/Metrics.ts";
import type * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  type ExecuteGitOptions,
  gitCommandContext,
  createTrace2Monitor,
} from "./GitCoreHelpers.ts";

export const makeGitExecution = () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    const path = yield* Path.Path;

    const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const executeRaw: GitVcsDriver.GitVcsDriver["Service"]["execute"] = Effect.fnUntraced(
      function* (input) {
        const commandInput = {
          ...input,
          args: [...input.args],
        } as const;

        const timeoutMs = input.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : input.timeoutMs;
        const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
        const appendTruncationMarker = input.appendTruncationMarker ?? false;

        const runGitCommand = Effect.fn("runGitCommand")(function* () {
          const trace2Monitor = yield* createTrace2Monitor(commandInput, input.progress).pipe(
            Effect.provideService(Path.Path, path),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.mapError(
              (cause) =>
                new GitCommandError({
                  ...gitCommandContext(commandInput),
                  detail: "Failed to create Git trace monitor.",
                  cause,
                }),
            ),
          );

          const child = yield* commandSpawner
            .spawn(
              ChildProcess.make("git", commandInput.args, {
                cwd: commandInput.cwd,
                env: {
                  ...process.env,
                  ...input.env,
                  ...trace2Monitor.env,
                },
              }),
            )
            .pipe(
              Effect.mapError(
                (cause) =>
                  new GitCommandError({
                    ...gitCommandContext(commandInput),
                    detail: "Failed to spawn Git process.",
                    cause,
                  }),
              ),
            );

          const [stdout, stderr, exitCode] = yield* Effect.all(
            [
              collectOutput(
                commandInput,
                child.stdout,
                maxOutputBytes,
                appendTruncationMarker,
                input.progress?.onStdoutLine,
              ),
              collectOutput(
                commandInput,
                child.stderr,
                maxOutputBytes,
                appendTruncationMarker,
                input.progress?.onStderrLine,
              ),
              child.exitCode.pipe(
                Effect.mapError(
                  (cause) =>
                    new GitCommandError({
                      ...gitCommandContext(commandInput),
                      detail: "Failed to read Git process exit code.",
                      cause,
                    }),
                ),
              ),
              input.stdin === undefined
                ? Effect.void
                : Stream.run(Stream.encodeText(Stream.make(input.stdin)), child.stdin).pipe(
                    Effect.mapError(
                      (cause) =>
                        new GitCommandError({
                          ...gitCommandContext(commandInput),
                          detail: "Failed to write Git process input.",
                          cause,
                        }),
                    ),
                  ),
            ],
            { concurrency: "unbounded" },
          ).pipe(Effect.map(([stdout, stderr, exitCode]) => [stdout, stderr, exitCode] as const));

          yield* trace2Monitor.flush;

          if (!input.allowNonZeroExit && exitCode !== 0) {
            return yield* new GitCommandError({
              ...gitCommandContext(commandInput),
              detail: "Git command exited with a non-zero status.",
              exitCode,
              stdoutLength: stdout.text.length,
              stderrLength: stderr.text.length,
            });
          }

          return {
            exitCode,
            stdout: stdout.text,
            stderr: stderr.text,
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated,
          } satisfies GitVcsDriver.ExecuteGitResult;
        });

        const execution = runGitCommand().pipe(Effect.scoped);

        if (timeoutMs === null) {
          return yield* execution;
        }

        return yield* execution.pipe(
          Effect.timeoutOption(timeoutMs),
          Effect.flatMap((result) =>
            Option.match(result, {
              onNone: () =>
                Effect.fail(
                  new GitCommandError({
                    ...gitCommandContext(commandInput),
                    detail: "Git command timed out.",
                  }),
                ),
              onSome: Effect.succeed,
            }),
          ),
        );
      },
    );

    const execute: GitVcsDriver.GitVcsDriver["Service"]["execute"] = (input) =>
      executeRaw(input).pipe(
        withMetrics({
          counter: gitCommandsTotal,
          timer: gitCommandDuration,
          attributes: {
            operation: input.operation,
          },
        }),
        Effect.withSpan(input.operation, {
          kind: "client",
          attributes: {
            "git.operation": input.operation,
            "git.cwd": input.cwd,
            "git.args_count": input.args.length,
          },
        }),
      );

    const executeGit = (
      operation: string,
      cwd: string,
      args: readonly string[],
      options: ExecuteGitOptions = {},
    ): Effect.Effect<GitVcsDriver.ExecuteGitResult, GitCommandError> =>
      execute({
        operation,
        cwd,
        args,
        ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        allowNonZeroExit: true,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
        ...(options.appendTruncationMarker !== undefined
          ? { appendTruncationMarker: options.appendTruncationMarker }
          : {}),
        ...(options.progress ? { progress: options.progress } : {}),
      }).pipe(
        Effect.flatMap((result) => {
          if (options.allowNonZeroExit || result.exitCode === 0) {
            return Effect.succeed(result);
          }

          return Effect.fail(
            new GitCommandError({
              ...gitCommandContext({ operation, cwd, args }),
              detail: options.fallbackErrorDetail ?? "Git command exited with a non-zero status.",
              ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
              stdoutLength: result.stdout.length,
              stderrLength: result.stderr.length,
            }),
          );
        }),
      );

    const executeGitWithStableDiagnostics = (
      operation: string,
      cwd: string,
      args: readonly string[],
      options: ExecuteGitOptions = {},
    ): Effect.Effect<GitVcsDriver.ExecuteGitResult, GitCommandError> =>
      executeGit(operation, cwd, args, {
        ...options,
        env: {
          ...options.env,
          LC_ALL: "C",
        },
      });

    const runGit = (
      operation: string,
      cwd: string,
      args: readonly string[],
      options: ExecuteGitOptions = {},
    ): Effect.Effect<void, GitCommandError> =>
      executeGit(operation, cwd, args, options).pipe(Effect.asVoid);

    const runGitStdout = (
      operation: string,
      cwd: string,
      args: readonly string[],
      allowNonZeroExit = false,
    ): Effect.Effect<string, GitCommandError> =>
      executeGit(operation, cwd, args, { allowNonZeroExit }).pipe(
        Effect.map((result) => result.stdout),
      );

    return {
      fileSystem,
      path,
      execute,
      executeGit,
      executeGitWithStableDiagnostics,
      runGit,
      runGitStdout,
    };
  });

export type GitExecutionServices = Effect.Success<ReturnType<typeof makeGitExecution>>;
