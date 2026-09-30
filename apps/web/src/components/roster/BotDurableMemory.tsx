import {
  DURABLE_MEMORY_INSPECT_SCOPES,
  type DurableFactIntent,
  type DurableMemoryExportScope,
  type DurableMemoryFact,
  describeDurableFactFailure,
  durableFactMutation,
  durableFactReadOnlyReason,
} from "@t3tools/client-runtime/durable-memory";
import { type OperateAccess } from "@t3tools/client-runtime/authorization";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useMemo, useState } from "react";

import {
  type DurableFactEditing,
  DurableFactList,
  DurableScopePicker,
} from "./DurableMemoryPanels";

import { isElectron } from "../../env";
import { useI18n } from "../../i18n";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { usePrimarySessionState } from "../../environments/primary";
import { environmentBotsAtom } from "../../state/bots";
import { useThreadShells } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { memoryEnvironment } from "../../state/memory";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentSessionState } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  resolvePrimaryOperateAccess,
  resolveRemoteOperateAccess,
} from "@t3tools/client-runtime/authorization";

interface BotDurableMemoryProps {
  readonly threadRef: ScopedThreadRef;
  readonly botId: string;
}

/**
 * Durable facts saved beyond this chat, one scope at a time. Fact actions only show when this
 * client's connection may change memory; a read-only pairing sees the facts without them.
 */
export function BotDurableMemory(props: BotDurableMemoryProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  if (props.threadRef.environmentId !== primaryEnvironmentId) {
    return <RemoteBotDurableMemory {...props} />;
  }
  // The desktop app owns its primary server outright.
  if (isElectron) return <DurableFactsSection {...props} access="granted" />;
  return <PrimaryBotDurableMemory {...props} />;
}

function PrimaryBotDurableMemory(props: BotDurableMemoryProps) {
  const session = usePrimarySessionState();
  const access = resolvePrimaryOperateAccess({
    isPrimary: true,
    hasDesktopBridge: false,
    session: session.data,
    isPending: session.isPending,
    hasError: session.error !== null,
  });
  return <DurableFactsSection {...props} access={access} />;
}

function RemoteBotDurableMemory(props: BotDurableMemoryProps) {
  const session = useEnvironmentSessionState(props.threadRef.environmentId);
  const access = resolveRemoteOperateAccess({
    session: session.data,
    isPending: session.isPending,
    hasError: session.hasError,
  });
  return <DurableFactsSection {...props} access={access} />;
}

function DurableFactsSection({
  threadRef,
  botId,
  access,
}: BotDurableMemoryProps & { readonly access: OperateAccess }) {
  const { t } = useI18n();
  const memory = useEnvironmentSettings(threadRef.environmentId, (settings) => settings.memory);
  const policy = useMemo(
    () => ({
      canOperate: access === "granted",
      memoryEnabled: memory.enabled,
      privateBotMemory: memory.privateBotMemory,
    }),
    [access, memory.enabled, memory.privateBotMemory],
  );
  // Pending access hides actions without a reason; they appear once it resolves.
  const readOnlyReason =
    access === "pending" && memory.enabled ? null : durableFactReadOnlyReason(policy);
  const threadShells = useThreadShells();
  const bots = useAtomValue(environmentBotsAtom(threadRef.environmentId));
  const threadTitles = useMemo(
    () =>
      new Map(
        threadShells
          .filter((shell) => shell.environmentId === threadRef.environmentId)
          .map((shell) => [shell.id as string, shell.title]),
      ),
    [threadShells, threadRef.environmentId],
  );
  const botNames = useMemo(() => new Map(bots.map((bot) => [bot.id as string, bot.name])), [bots]);
  const [scope, setScope] = useState<DurableMemoryExportScope>("bot");
  const [busyRootId, setBusyRootId] = useState<string | null>(null);
  const [editing, setEditing] = useState<DurableFactEditing | null>(null);
  const [confirmingDeleteRootId, setConfirmingDeleteRootId] = useState<string | null>(null);
  const [failure, setFailure] = useState<ReturnType<typeof describeDurableFactFailure> | null>(
    null,
  );
  const mutateFact = useAtomCommand(memoryEnvironment.mutateFact, { reportFailure: false });
  const query = useEnvironmentQuery(
    memoryEnvironment.listFacts({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, target: scope },
    }),
  );

  const resetDrafts = () => {
    setEditing(null);
    setConfirmingDeleteRootId(null);
  };
  const runIntent = async (fact: DurableMemoryFact, intent: DurableFactIntent) => {
    setBusyRootId(fact.rootId);
    setFailure(null);
    try {
      const result = await mutateFact({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, mutation: durableFactMutation(fact, intent) },
      });
      if (result._tag === "Failure") {
        const described = describeDurableFactFailure(squashAtomCommandFailure(result));
        setFailure(described);
        // A stale edit would overwrite the newer text, so drop it with the old revision.
        if (described.conflict) resetDrafts();
        return;
      }
      resetDrafts();
    } finally {
      setBusyRootId(null);
    }
  };

  return (
    <section className="space-y-3 rounded-lg border border-border p-3">
      <div>
        <h3 className="text-sm font-medium">{t("Durable facts")}</h3>
        <p className="text-xs text-muted-foreground">
          {t("Facts kept beyond this chat. Clearing chat observations does not remove them.")}
        </p>
      </div>
      <DurableScopePicker
        label="Durable fact scope"
        options={DURABLE_MEMORY_INSPECT_SCOPES}
        value={scope}
        onChange={(next) => {
          resetDrafts();
          setFailure(null);
          setScope(next);
        }}
      />
      {query.error ? (
        <p role="alert" className="text-sm text-destructive">
          {t("Durable facts unavailable.")}
        </p>
      ) : null}
      {failure ? (
        <p role="alert" className="text-sm text-destructive">
          {t(failure.message)}
          {failure.detail ? ` ${failure.detail}` : null}
        </p>
      ) : null}
      {query.isPending && !query.data ? (
        <p className="text-sm text-muted-foreground">{t("Loading durable facts…")}</p>
      ) : null}
      {query.data && !query.error ? (
        <DurableFactList
          facts={query.data.facts}
          currentThreadId={threadRef.threadId}
          currentBotId={botId}
          threadTitles={threadTitles}
          botNames={botNames}
          policy={policy}
          busyRootId={busyRootId}
          editing={editing}
          confirmingDeleteRootId={confirmingDeleteRootId}
          onIntent={(fact, intent) => void runIntent(fact, intent)}
          onStartEdit={(fact) => {
            setConfirmingDeleteRootId(null);
            setEditing({ rootId: fact.rootId, draft: fact.fact });
          }}
          onDraftChange={(draft) =>
            setEditing((current) => (current ? { ...current, draft } : current))
          }
          onCancelEdit={() => setEditing(null)}
          onRequestDelete={(fact) => {
            setEditing(null);
            setConfirmingDeleteRootId(fact.rootId);
          }}
          onCancelDelete={() => setConfirmingDeleteRootId(null)}
        />
      ) : null}
      {readOnlyReason ? <p className="text-xs text-muted-foreground">{t(readOnlyReason)}</p> : null}
    </section>
  );
}
