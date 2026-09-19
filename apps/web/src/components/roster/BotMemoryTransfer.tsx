import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AkeruMarkdownMemoryArchiveV3,
  type AkeruMarkdownMemoryImportPreview,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { memoryEnvironment } from "../../state/memory";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

const decodeArchive = Schema.decodeUnknownSync(AkeruMarkdownMemoryArchiveV3);

export function BotMemoryTransfer({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const exportArchive = useAtomCommand(memoryEnvironment.exportArchive, { reportFailure: false });
  const previewImport = useAtomCommand(memoryEnvironment.previewImport, { reportFailure: false });
  const applyImport = useAtomCommand(memoryEnvironment.applyImport, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    archive: AkeruMarkdownMemoryArchiveV3;
    preview: AkeruMarkdownMemoryImportPreview;
  } | null>(null);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Memory transfer failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-medium">Transfer memory</h3>
      <p className="text-xs text-muted-foreground">
        Export this bot's notes and this chat's observations. Review an import before replacing
        them.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() =>
          void run(async () => {
            const result = await exportArchive({
              environmentId: threadRef.environmentId,
              input: { threadId: threadRef.threadId },
            });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            const url = URL.createObjectURL(
              new Blob([JSON.stringify(result.value, null, 2)], { type: "application/json" }),
            );
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = `akeru-memory-${threadRef.threadId}.json`;
            anchor.click();
            setTimeout(() => URL.revokeObjectURL(url), 0);
          })
        }
      >
        Export memory
      </Button>
      <Input
        aria-label="Import memory archive"
        type="file"
        accept="application/json,.json"
        disabled={busy}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (!file) return;
          setPending(null);
          void run(async () => {
            const archive = decodeArchive(JSON.parse(await file.text()));
            const result = await previewImport({
              environmentId: threadRef.environmentId,
              input: { threadId: threadRef.threadId, archive },
            });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            setPending({ archive, preview: result.value });
          });
        }}
      />
      {pending ? (
        <div className="space-y-2 text-sm">
          {pending.preview.documents.map((item) => (
            <p key={item.target}>
              {item.target}: {item.classification}, {item.charCount} / {item.charLimit} characters
            </p>
          ))}
          <p>
            {pending.preview.restoresObservations
              ? "This import will replace this chat's observations."
              : "Chat observations are unchanged."}
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPending(null)}>
              Cancel import
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await applyImport({
                    environmentId: threadRef.environmentId,
                    input: {
                      threadId: threadRef.threadId,
                      archive: pending.archive,
                      previewHash: pending.preview.previewHash,
                    },
                  });
                  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                  setPending(null);
                })
              }
            >
              Apply import
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
