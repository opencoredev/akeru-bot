import {
  ServerConfigLayer,
  TestLayer,
  makeNonRepositoryHandle,
  makeSuccessfulHandle,
  makeTmpDir,
  writeTextFile,
  git,
  initRepoWithCommit,
} from "./testUtils/gitCore.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, describe } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { makeGitVcsDriverCore } from "./GitVcsDriverCore.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";

it.effect("marks the current branch when worktree metadata is unavailable", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;

      const incompleteMetadataSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("expected a standard Git command");
          }

          const isWorktreeRoot =
            command.args.includes("rev-parse") && command.args.includes("--show-toplevel");

          const isWorktreeList =
            command.args.includes("worktree") && command.args.includes("--porcelain");

          if (isWorktreeRoot || isWorktreeList) {
            return makeNonRepositoryHandle();
          }

          return yield* delegate.spawn(command);
        }),
      );

      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, incompleteMetadataSpawner),
      );

      const cwd = yield* makeTmpDir();

      const { initialBranch } = yield* initRepoWithCommit(cwd).pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, driver),
      );

      const refs = yield* driver.listRefs({ cwd, refresh: true });

      assert.isTrue(refs.isRepo);
      assert.isTrue(refs.refs.find((ref) => ref.name === initialBranch)?.current);
    }),
  ).pipe(Effect.provide(ServerConfigLayer.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("ignores worktree metadata for directories that no longer exist", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const missingWorktreePath = "/missing/deleted-worktree";

      const staleWorktreeSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("expected a standard Git command");
          }

          const isWorktreeList =
            command.args.includes("worktree") && command.args.includes("--porcelain");

          if (isWorktreeList) {
            return makeSuccessfulHandle(
              `worktree ${missingWorktreePath}\0HEAD deadbeef\0branch refs/heads/stale-worktree\0\0`,
            );
          }

          return yield* delegate.spawn(command);
        }),
      );

      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, staleWorktreeSpawner),
      );

      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));
      yield* git(cwd, ["branch", "stale-worktree"]).pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, driver),
      );

      const refs = yield* driver.listRefs({ cwd, refresh: true });

      assert.equal(refs.refs.find((ref) => ref.name === "stale-worktree")?.worktreePath, null);
    }),
  ).pipe(Effect.provide(ServerConfigLayer.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect("backs off failed upstream refreshes across linked worktrees", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fetchAttempts = yield* Ref.make(0);

      const failingFetchSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("expected a standard Git command");
          }

          if (command.args.includes("fetch") && command.args.includes("--quiet")) {
            yield* Ref.update(fetchAttempts, (count) => count + 1);

            return makeNonRepositoryHandle();
          }

          return yield* delegate.spawn(command);
        }),
      );

      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, failingFetchSpawner),
      );

      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-vcs-driver-remote-");
      const worktreesRoot = yield* makeTmpDir("git-vcs-driver-worktrees-");
      const pathService = yield* Path.Path;
      const worktreePath = pathService.join(worktreesRoot, "linked");

      const runGit = (workingDirectory: string, args: ReadonlyArray<string>) =>
        driver.execute({
          operation: "GitVcsDriver.test.upstreamRefreshBackoff",
          cwd: workingDirectory,
          args,
          timeoutMs: 10_000,
        });

      yield* driver.initRepo({ cwd });
      yield* runGit(cwd, ["config", "user.email", "test@test.com"]);
      yield* runGit(cwd, ["config", "user.name", "Test"]);
      yield* writeTextFile(cwd, "README.md", "# test\n");
      yield* runGit(cwd, ["add", "."]);
      yield* runGit(cwd, ["commit", "-m", "initial commit"]);
      const initialBranch = (yield* runGit(cwd, ["branch", "--show-current"])).stdout.trim();
      yield* runGit(remote, ["init", "--bare"]);
      yield* runGit(cwd, ["remote", "add", "origin", remote]);
      yield* runGit(cwd, ["push", "-u", "origin", initialBranch]);
      yield* runGit(cwd, ["worktree", "add", "-b", "feature/linked", worktreePath]);
      yield* runGit(worktreePath, [
        "branch",
        "--set-upstream-to",
        `origin/${initialBranch}`,
        "feature/linked",
      ]);
      const rootCommonDir = (yield* runGit(cwd, ["rev-parse", "--git-common-dir"])).stdout.trim();

      const linkedCommonDir = (yield* runGit(worktreePath, [
        "rev-parse",
        "--git-common-dir",
      ])).stdout.trim();

      assert.equal(
        yield* fileSystem.realPath(pathService.resolve(cwd, rootCommonDir)),
        yield* fileSystem.realPath(pathService.resolve(worktreePath, linkedCommonDir)),
      );
      yield* Ref.set(fetchAttempts, 0);

      yield* driver.statusDetailsRemote(cwd);
      yield* driver.statusDetailsRemote(worktreePath);
      assert.equal(yield* Ref.get(fetchAttempts), 1);

      yield* TestClock.adjust("29 seconds");
      yield* driver.statusDetailsRemote(worktreePath);
      assert.equal(yield* Ref.get(fetchAttempts), 1);

      yield* TestClock.adjust("1 second");
      yield* driver.statusDetailsRemote(cwd);
      assert.equal(yield* Ref.get(fetchAttempts), 2);

      yield* TestClock.adjust("59 seconds");
      yield* driver.statusDetailsRemote(worktreePath);
      assert.equal(yield* Ref.get(fetchAttempts), 2);

      yield* TestClock.adjust("1 second");
      yield* driver.statusDetailsRemote(cwd);
      assert.equal(yield* Ref.get(fetchAttempts), 3);
    }),
  ).pipe(Effect.provide(ServerConfigLayer.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.layer(TestLayer)("GitVcsDriver core integration", (it) => {
  describe("worktree operations", () => {
    it.effect("preserves newline characters in worktree paths when listing refs", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const worktreesRoot = yield* makeTmpDir("git-vcs-driver-worktrees-");
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(worktreesRoot, "linked\nworktree");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* git(cwd, ["worktree", "add", "-b", "feature/newline-path", worktreePath]);

        const refs = yield* driver.listRefs({ cwd, refresh: true });

        const listedPath = refs.refs.find(
          (ref) => ref.name === "feature/newline-path",
        )?.worktreePath;

        if (typeof listedPath !== "string") {
          return assert.fail("expected the linked branch to include its worktree path");
        }

        assert.equal(
          yield* fileSystem.realPath(listedPath),
          yield* fileSystem.realPath(worktreePath),
        );
      }),
    );

    it.effect("checks out submodules in a new worktree", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;

        // Git refuses `file:` submodule transports by default (CVE-2022-39253)
        // and ignores repo-level config for it, so a local fixture needs the
        // env allowance. Real submodules are https/ssh and need none of this.
        const previousAllowedProtocol = process.env.GIT_ALLOW_PROTOCOL;
        process.env.GIT_ALLOW_PROTOCOL = "file";
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (previousAllowedProtocol === undefined) {
              delete process.env.GIT_ALLOW_PROTOCOL;
            } else {
              process.env.GIT_ALLOW_PROTOCOL = previousAllowedProtocol;
            }
          }),
        );

        // A real submodule: `git worktree add` leaves these empty, which is
        // what silently strips shared tooling out of every new worktree.
        const submoduleRepo = yield* makeTmpDir("git-submodule-");
        yield* initRepoWithCommit(submoduleRepo);
        yield* writeTextFile(submoduleRepo, "SHARED.md", "# shared\n");
        yield* git(submoduleRepo, ["add", "."]);
        yield* git(submoduleRepo, ["commit", "-m", "shared"]);

        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["submodule", "add", submoduleRepo, "shared"]);
        yield* git(cwd, ["commit", "-m", "add submodule"]);

        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "submodule-worktree",
        );

        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/submodules",
        });

        assert.equal(
          yield* fileSystem.exists(pathService.join(worktreePath, "shared", "SHARED.md")),
          true,
        );
      }),
    );

    it.effect("still creates the worktree when submodule checkout fails", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;

        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        // Points at a repository that does not exist, so the checkout fails the
        // way an unreachable private remote would. Creation must still succeed.
        yield* writeTextFile(
          cwd,
          ".gitmodules",
          '[submodule "missing"]\n\tpath = missing\n\turl = /nonexistent/repo.git\n',
        );
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "add unreachable submodule"]);

        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "broken-submodule-worktree",
        );

        const driver = yield* GitVcsDriver.GitVcsDriver;

        const created = yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/broken-submodules",
        });

        assert.equal(created.worktree.path, worktreePath);
        assert.equal(yield* fileSystem.exists(worktreePath), true);
      }),
    );

    it.effect("creates and removes a worktree for a new refName", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const pathService = yield* Path.Path;

        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "feature-worktree",
        );

        const driver = yield* GitVcsDriver.GitVcsDriver;

        const created = yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/worktree",
        });

        assert.equal(created.worktree.path, worktreePath);
        assert.equal(created.worktree.refName, "feature/worktree");
        assert.equal(yield* git(worktreePath, ["branch", "--show-current"]), "feature/worktree");

        yield* driver.removeWorktree({ cwd, path: worktreePath });
        const fileSystem = yield* FileSystem.FileSystem;
        assert.equal(yield* fileSystem.exists(worktreePath), false);
      }),
    );

    it.effect("removes the same worktree path twice without failing", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(yield* makeTmpDir("git-worktrees-"), "shared");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/shared",
        });

        // Two threads can record the same worktree path; the second delete
        // must be a no-op instead of exit 128.
        yield* driver.removeWorktree({ cwd, path: worktreePath });
        yield* driver.removeWorktree({ cwd, path: worktreePath });
      }),
    );

    it.effect("prunes stale registrations when removing an already-gone worktree", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const pathService = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const worktreesRoot = yield* makeTmpDir("git-worktrees-");
        const stalePath = pathService.join(worktreesRoot, "stale");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* driver.createWorktree({
          cwd,
          path: stalePath,
          refName: initialBranch,
          newRefName: "feature/stale",
        });
        // Delete the directory behind git's back so the registration goes stale.
        yield* fileSystem.remove(stalePath, { recursive: true });

        yield* driver.removeWorktree({
          cwd,
          path: pathService.join(worktreesRoot, "never-registered"),
        });

        const registered = yield* git(cwd, ["worktree", "list", "--porcelain"]);
        assert.notInclude(registered, "stale");
      }),
    );
  });
});
