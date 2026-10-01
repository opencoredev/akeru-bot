import type { EnvironmentProject } from "@akeru/client-runtime/state/shell";
import { useNavigation } from "@react-navigation/native";
import { useEffect, useRef, useState } from "react";
import { Alert } from "react-native";
import { useMobileI18n } from "../../lib/i18n";
import {
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
  restoreComposerDraftSnapshot,
  type ComposerDraft,
} from "../../state/use-composer-drafts";
import { useIncomingShare } from "../sharing/IncomingShareProvider";

/**
 * Moves a durable native share into the selected project's draft. One state
 * machine owns the inbox reservation, the draft merge with its rollback
 * snapshot, consumption, and the cancel and retry alerts; the screen reads
 * the returned flags to gate editing, starting, and leaving.
 */
export function useNewTaskShareImport(input: {
  readonly incomingShareId: string | undefined;
  readonly initialEnvironmentId: string | undefined;
  readonly initialProjectId: string | undefined;
  readonly draftKey: string | null;
  readonly selectedProject: EnvironmentProject | null;
}) {
  const { plural, t } = useMobileI18n();
  const navigation = useNavigation();
  const {
    consumeShare,
    getShare,
    isLoading: isIncomingShareInboxLoading,
    releaseShareReservation,
    reserveShare,
  } = useIncomingShare();
  const [importingShareKey, setImportingShareKey] = useState<string | null>(null);
  const [isCancellingShareImport, setIsCancellingShareImport] = useState(false);
  const [cancelledIncomingShareId, setCancelledIncomingShareId] = useState<string | null>(null);
  const [shareImportAttempt, setShareImportAttempt] = useState(0);
  const startedShareImportKeyRef = useRef<string | null>(null);
  const cancellingShareImportKeyRef = useRef<string | null>(null);
  const shareImportDraftBackupRef = useRef(new Map<string, ComposerDraft>());
  const activeShareImportTokenRef = useRef<symbol | null>(null);
  const shareImportMountedRef = useRef(true);
  const latestDraftKeyRef = useRef(input.draftKey);
  const latestIncomingShareIdRef = useRef(input.incomingShareId);
  latestDraftKeyRef.current = input.draftKey;
  latestIncomingShareIdRef.current = input.incomingShareId;
  const isImportingShare = importingShareKey !== null;
  const alertedUnavailableIncomingShareIdRef = useRef<string | null>(null);
  const incomingShare = input.incomingShareId ? getShare(input.incomingShareId) : null;
  const isIncomingShareTransferPending = Boolean(
    incomingShare && cancelledIncomingShareId !== input.incomingShareId,
  );
  const hasImportedIncomingShare = Boolean(
    input.incomingShareId &&
    input.draftKey &&
    getComposerDraftSnapshot(input.draftKey).importedShareIds?.includes(input.incomingShareId),
  );
  const isIncomingShareUnavailable = Boolean(
    input.incomingShareId &&
    !isIncomingShareInboxLoading &&
    !incomingShare &&
    !hasImportedIncomingShare,
  );
  const isIncomingShareReady =
    !input.incomingShareId ||
    (hasImportedIncomingShare && !incomingShare) ||
    isIncomingShareUnavailable;
  useEffect(() => {
    if (cancelledIncomingShareId === input.incomingShareId) {
      navigation.goBack();
    }
  }, [cancelledIncomingShareId, navigation, input.incomingShareId]);
  useEffect(() => {
    if (!shareImportMountedRef.current) {
      startedShareImportKeyRef.current = null;
    }
    shareImportMountedRef.current = true;
    return () => {
      shareImportMountedRef.current = false;
      activeShareImportTokenRef.current = null;
      cancellingShareImportKeyRef.current = null;
    };
  }, []);

  useEffect(() => {
    const shareId = input.incomingShareId;
    const draftKey = input.draftKey;
    const destinationProject = input.selectedProject;
    const initialEnvironmentId = input.initialEnvironmentId;
    const initialProjectId = input.initialProjectId;
    const selectedProjectMatchesRoute =
      !initialEnvironmentId ||
      !initialProjectId ||
      (destinationProject?.environmentId === initialEnvironmentId &&
        destinationProject.id === initialProjectId);
    if (
      !shareId ||
      !draftKey ||
      !destinationProject ||
      !selectedProjectMatchesRoute ||
      cancelledIncomingShareId === shareId
    ) {
      return;
    }
    const importKey = `${shareId}:${draftKey}`;
    if (
      startedShareImportKeyRef.current === importKey ||
      cancellingShareImportKeyRef.current === importKey
    ) {
      return;
    }

    if (!incomingShare) {
      if (isIncomingShareUnavailable && alertedUnavailableIncomingShareIdRef.current !== shareId) {
        alertedUnavailableIncomingShareIdRef.current = shareId;
        Alert.alert(
          t("Shared content unavailable"),
          t(
            "The shared content is no longer in the inbox. You can continue editing this chat draft.",
          ),
        );
      }
      return;
    }

    if (alertedUnavailableIncomingShareIdRef.current === shareId) {
      alertedUnavailableIncomingShareIdRef.current = null;
    }
    startedShareImportKeyRef.current = importKey;
    const draftBackup =
      shareImportDraftBackupRef.current.get(importKey) ?? getComposerDraftSnapshot(draftKey);
    shareImportDraftBackupRef.current.set(importKey, draftBackup);
    const importToken = Symbol(importKey);
    let didReserveShare = false;
    let needsDraftRestore = false;
    activeShareImportTokenRef.current = importToken;
    setImportingShareKey(importKey);
    void (async () => {
      await reserveShare(shareId, {
        environmentId: String(destinationProject.environmentId),
        projectId: String(destinationProject.id),
      });
      didReserveShare = true;
      if (
        !shareImportMountedRef.current ||
        activeShareImportTokenRef.current !== importToken ||
        latestDraftKeyRef.current !== draftKey ||
        latestIncomingShareIdRef.current !== shareId
      ) {
        return;
      }
      needsDraftRestore = true;
      const { skippedAttachmentCount } = await mergeComposerDraftContent(draftKey, {
        text: incomingShare.text,
        attachments: incomingShare.attachments,
        sourceShareId: shareId,
      });
      if (
        !shareImportMountedRef.current ||
        activeShareImportTokenRef.current !== importToken ||
        latestDraftKeyRef.current !== draftKey ||
        latestIncomingShareIdRef.current !== shareId
      ) {
        // The durable reservation makes an interrupted transfer resume only
        // in this project instead of copying into a second project draft.
        return;
      }
      await consumeShare(shareId);
      if (!shareImportMountedRef.current || activeShareImportTokenRef.current !== importToken) {
        return;
      }
      const warnings = [...incomingShare.warnings];
      if (skippedAttachmentCount > 0) {
        warnings.push(
          plural(skippedAttachmentCount, {
            one: "{count} shared image was skipped because this draft reached the attachment limit.",
            other:
              "{count} shared images were skipped because this draft reached the attachment limit.",
          }),
        );
      }
      if (warnings.length > 0) {
        Alert.alert(t("Some shared content was skipped"), warnings.join("\n"));
      }
      shareImportDraftBackupRef.current.delete(importKey);
    })()
      .catch((error) => {
        if (!shareImportMountedRef.current || activeShareImportTokenRef.current !== importToken) {
          return;
        }
        Alert.alert(
          t("Could not import shared content"),
          error instanceof Error ? error.message : t("The shared content could not be saved."),
          [
            {
              text: t("Cancel import"),
              style: "cancel",
              onPress: () => {
                const cancelImport = async (): Promise<void> => {
                  if (!shareImportMountedRef.current) {
                    return;
                  }
                  // Latch synchronously before restoring the draft. The
                  // restore publishes atom state and can re-run the import
                  // effect before React commits the cancelling state update.
                  cancellingShareImportKeyRef.current = importKey;
                  setIsCancellingShareImport(true);
                  try {
                    if (needsDraftRestore) {
                      await restoreComposerDraftSnapshot(draftKey, draftBackup);
                      needsDraftRestore = false;
                    }
                    if (didReserveShare) {
                      await releaseShareReservation(shareId, {
                        environmentId: String(destinationProject.environmentId),
                        projectId: String(destinationProject.id),
                      });
                    }
                    shareImportDraftBackupRef.current.delete(importKey);
                    if (shareImportMountedRef.current) {
                      setIsCancellingShareImport(false);
                      setCancelledIncomingShareId(shareId);
                    }
                  } catch (cancelError) {
                    if (!shareImportMountedRef.current) {
                      return;
                    }
                    Alert.alert(
                      t("Could not cancel import"),
                      cancelError instanceof Error
                        ? cancelError.message
                        : t("The shared content could not be restored safely."),
                      [
                        {
                          text: t("Retry import"),
                          onPress: () => {
                            cancellingShareImportKeyRef.current = null;
                            setIsCancellingShareImport(false);
                            setShareImportAttempt((attempt) => attempt + 1);
                          },
                        },
                        {
                          text: t("Retry cancel"),
                          onPress: () => void cancelImport(),
                        },
                      ],
                      { cancelable: false },
                    );
                  }
                };
                void cancelImport();
              },
            },
            {
              text: t("Retry"),
              onPress: () => setShareImportAttempt((attempt) => attempt + 1),
            },
          ],
          { cancelable: false },
        );
      })
      .finally(() => {
        if (startedShareImportKeyRef.current === importKey) {
          // Every terminal path, including an invalidated operation, must
          // release the synchronous start latch so this transfer can retry.
          startedShareImportKeyRef.current = null;
        }
        if (shareImportMountedRef.current && activeShareImportTokenRef.current === importToken) {
          activeShareImportTokenRef.current = null;
          setImportingShareKey(null);
        }
      });
  }, [
    consumeShare,
    cancelledIncomingShareId,
    input.draftKey,
    hasImportedIncomingShare,
    incomingShare,
    isIncomingShareInboxLoading,
    isIncomingShareUnavailable,
    input.incomingShareId,
    input.initialEnvironmentId,
    input.initialProjectId,
    releaseShareReservation,
    reserveShare,
    input.selectedProject,
    shareImportAttempt,
  ]);

  return {
    isImportingShare,
    isCancellingShareImport,
    isIncomingShareTransferPending,
    isIncomingShareReady,
  };
}
