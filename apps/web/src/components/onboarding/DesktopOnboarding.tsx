import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@akeru/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AnimatePresence } from "motion/react";
import { useEffect, useRef, useState, type ComponentType } from "react";

import { isElectron } from "../../env";
import { environmentBotsAtom, environmentRosterLoadedAtom } from "../../state/bots";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { environmentShell } from "../../state/shell";
import { toastManager } from "../ui/toast";
import { useRosterStore } from "../roster/rosterStore";
import {
  clearDesktopOnboardingHandoff,
  DEFAULT_DESKTOP_ONBOARDING_DRAFT,
  DESKTOP_ONBOARDING_COMPLETED_STORAGE_KEY,
  type DesktopOnboardingDraft,
  markDesktopOnboardingFirstChat,
  markDesktopOnboardingHandoffStarted,
  readDesktopOnboardingDraft,
  readDesktopOnboardingHandoffForEnvironment,
  recoverMissingDesktopOnboardingBot,
  shouldShowDesktopOnboarding,
  writeDesktopOnboardingDraft,
} from "./desktopOnboarding.logic";
import { type DesktopOnboardingSurfaceProps, OnboardingSurface } from "./DesktopOnboardingSurface";

export { SubscriptionStep } from "./OnboardingSubscriptionStep";

// SAFETY: the empty ID is an inactive-query sentinel; no environment request is sent for it.
const NO_ENVIRONMENT = "" as EnvironmentId;

function readDraft(): DesktopOnboardingDraft | null {
  return readDesktopOnboardingDraft(window.localStorage);
}

function writeDraft(draft: DesktopOnboardingDraft): void {
  writeDesktopOnboardingDraft(window.localStorage, draft);
}

function readCaptureMode(): boolean {
  return (
    import.meta.env.DEV &&
    new URLSearchParams(window.location.search).get("akeru-onboarding-capture") === "1"
  );
}

export function DesktopOnboarding({
  Surface = OnboardingSurface,
}: {
  readonly Surface?: ComponentType<DesktopOnboardingSurfaceProps>;
} = {}) {
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  const atomKey = environmentId ?? NO_ENVIRONMENT;
  const shellLive = useAtomValue(environmentShell.stateValueAtom(atomKey)).status === "live";
  const rosterLoaded = useAtomValue(environmentRosterLoadedAtom(atomKey)) && shellLive;
  const serverBots = useAtomValue(environmentBotsAtom(atomKey));
  const attemptedHandoffRef = useRef<string | null>(null);
  const [draft] = useState(readDraft);

  const [completed] = useState(
    () => window.localStorage.getItem(DESKTOP_ONBOARDING_COMPLETED_STORAGE_KEY) === "1",
  );

  const [finished, setFinished] = useState(false);
  const initialDraftRef = useRef<DesktopOnboardingDraft | null>(draft);
  const [captureMode] = useState(readCaptureMode);

  if (rosterLoaded && initialDraftRef.current) {
    const currentDraft = initialDraftRef.current;

    const recoveredDraft = recoverMissingDesktopOnboardingBot(
      currentDraft,
      serverBots.map((bot) => bot.id),
    );

    if (recoveredDraft !== currentDraft) {
      initialDraftRef.current = recoveredDraft;
      writeDraft(recoveredDraft);
    }
  }

  const shouldStart =
    !finished &&
    environmentId !== null &&
    (captureMode ||
      shouldShowDesktopOnboarding({
        desktop: isElectron,
        rosterLoaded,
        serverBotCount: serverBots.length,
        draft,
        completed,
        started: initialDraftRef.current !== null,
      }));

  if (shouldStart && initialDraftRef.current === null) {
    initialDraftRef.current = DEFAULT_DESKTOP_ONBOARDING_DRAFT;
    writeDraft(DEFAULT_DESKTOP_ONBOARDING_DRAFT);
  }

  const show = shouldStart && initialDraftRef.current !== null;

  // A reload between creating the bot and opening its chat lands
  // here with setup already complete. Finish the trip to that chat once.
  useEffect(() => {
    if (show || !environmentId || !rosterLoaded) return;

    const handoff = readDesktopOnboardingHandoffForEnvironment(
      window.localStorage,
      environmentId,
      serverBots.map((bot) => bot.id),
    );

    if (
      !handoff ||
      handoff.environmentId !== environmentId ||
      attemptedHandoffRef.current === handoff.botId
    )
      return;
    const handoffBot = serverBots.find((bot) => bot.id === handoff.botId);

    if (handoffBot?.archivedAt) {
      clearDesktopOnboardingHandoff(window.localStorage);
      toastManager.add({
        type: "error",
        title: "Your new bot was archived before its chat opened. Create or select another bot.",
      });

      return;
    }

    if (!handoffBot) {
      return;
    }

    const botId = handoff.botId;
    attemptedHandoffRef.current = botId;
    useRosterStore.getState().selectBot(botId);
    void navigate({ to: "/bots/$botId", params: { botId }, replace: true }).then(
      () => clearDesktopOnboardingHandoff(window.localStorage),
      () =>
        toastManager.add({
          type: "error",
          title: "Could not reopen your new chat. Reload to try again.",
        }),
    );
  }, [environmentId, navigate, rosterLoaded, serverBots, show]);

  useEffect(() => {
    if (!environmentId || !rosterLoaded) return;
    const botId = initialDraftRef.current?.botId;

    if (!botId || !serverBots.some((bot) => bot.id === botId && !bot.archivedAt)) return;
    markDesktopOnboardingFirstChat(window.localStorage, botId);
    markDesktopOnboardingHandoffStarted(window.localStorage, environmentId, botId);
    setFinished(true);
  }, [environmentId, rosterLoaded, serverBots]);

  useEffect(() => {
    if (!rosterLoaded || serverBots.length === 0 || initialDraftRef.current !== null) return;
    window.localStorage.setItem(DESKTOP_ONBOARDING_COMPLETED_STORAGE_KEY, "1");
  }, [rosterLoaded, serverBots.length]);

  return (
    <AnimatePresence>
      {show && initialDraftRef.current && environmentId ? (
        <Surface
          key="desktop-onboarding"
          initialDraft={initialDraftRef.current}
          environmentId={environmentId}
          captureMode={captureMode}
          onFinished={() => setFinished(true)}
        />
      ) : null}
    </AnimatePresence>
  );
}
