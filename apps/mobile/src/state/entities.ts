import { useAtomValue } from "@effect/atom-react";
import { useMemo } from "react";
import type { EnvironmentProject, EnvironmentThreadShell } from "@akeru/client-runtime/state/shell";
import type {
  EnvironmentId,
  ScopedProjectRef,
  ScopedThreadRef,
  ServerConfig,
} from "@akeru/contracts";
import { Atom } from "effect/unstable/reactivity";

import { environmentProjects } from "./projects";
import { environmentServerConfigsAtom, serverEnvironment } from "./server";
import { environmentThreadShells } from "./threads";

const EMPTY_PROJECT_ATOM = Atom.make<EnvironmentProject | null>(null).pipe(
  Atom.withLabel("mobile-project:empty"),
);
const EMPTY_THREAD_SHELL_ATOM = Atom.make<EnvironmentThreadShell | null>(null).pipe(
  Atom.withLabel("mobile-thread-shell:empty"),
);
const EMPTY_SERVER_CONFIG_ATOM = Atom.make<ServerConfig | null>(null).pipe(
  Atom.withLabel("mobile-server-config:empty"),
);

export function useProjects(): ReadonlyArray<EnvironmentProject> {
  return useAtomValue(environmentProjects.projectsAtom);
}

export function useThreadShells(): ReadonlyArray<EnvironmentThreadShell> {
  return useAtomValue(environmentThreadShells.threadShellsAtom);
}

export function useProject(ref: ScopedProjectRef | null): EnvironmentProject | null {
  return useAtomValue(ref === null ? EMPTY_PROJECT_ATOM : environmentProjects.projectAtom(ref));
}

export function useThreadShell(ref: ScopedThreadRef | null): EnvironmentThreadShell | null {
  return useAtomValue(
    ref === null ? EMPTY_THREAD_SHELL_ATOM : environmentThreadShells.threadShellAtom(ref),
  );
}

export function useEnvironmentServerConfig(
  environmentId: EnvironmentId | null,
): ServerConfig | null {
  return useAtomValue(
    environmentId === null
      ? EMPTY_SERVER_CONFIG_ATOM
      : serverEnvironment.configValueAtom(environmentId),
  );
}

export function useServerConfigs(): ReadonlyMap<EnvironmentId, ServerConfig> {
  return useAtomValue(environmentServerConfigsAtom);
}

const NO_THREAD_TITLES_ATOM = Atom.make("[]").pipe(Atom.withLabel("mobile-thread-titles:empty"));
// Keyed by the newline-joined thread ids. The value is a JSON string so the atom
// only notifies when one of these titles changes, not on every shell update.
const threadTitlesAtom = Atom.family((threadIdsKey: string) =>
  Atom.make((get) => {
    const titles = new Map<string, string>(
      get(environmentThreadShells.threadShellsAtom).map((shell) => [shell.id, shell.title]),
    );
    return JSON.stringify(
      threadIdsKey.split("\n").map((threadId) => [threadId, titles.get(threadId) ?? null]),
    );
  }).pipe(Atom.withLabel(`mobile-thread-titles:${threadIdsKey}`)),
);

/** Titles for the given chats, keyed by thread id. Chats the client cannot see are absent. */
export function useThreadTitles(threadIds: ReadonlyArray<string>): ReadonlyMap<string, string> {
  const key = threadIds.join("\n");
  const json = useAtomValue(key === "" ? NO_THREAD_TITLES_ATOM : threadTitlesAtom(key));
  return useMemo(() => {
    const titles = new Map<string, string>();
    for (const [threadId, title] of JSON.parse(json) as Array<[string, string | null]>) {
      if (title !== null) titles.set(threadId, title);
    }
    return titles;
  }, [json]);
}
