import { Predicate } from "effect";
import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted } from "@akeru/client-runtime/state/runtime";
import { BotId, ProjectId, type EnvironmentId } from "@akeru/contracts";
import { useNavigate } from "@tanstack/react-router";
import { LoaderIcon } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useI18n } from "../../i18n";
import { randomUUID } from "../../lib/utils";
import { botEnvironment } from "../../state/bots";
import {
  useAllEnvironmentShellsBootstrapped,
  useEnvironmentProjectRefs,
} from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { primaryServerConfigAtom, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { DEFAULT_BOT_RUNTIME_MODE } from "../roster/botSandbox";
import { randomBotAvatar } from "../roster/roster.logic";
import { useRosterStore } from "../roster/rosterStore";
import {
  clearDesktopOnboardingHandoff,
  DESKTOP_ONBOARDING_REVEAL_DURATION_MS,
  type DesktopOnboardingDraft,
  desktopOnboardingDefaultProjectCreateInput,
  markDesktopOnboardingCompleted,
  markDesktopOnboardingFirstChat,
  markDesktopOnboardingHandoffStarted,
  pickDesktopOnboardingTeammateName,
  resolveDesktopOnboardingCreationReadiness,
  writeDesktopOnboardingDraft,
} from "./desktopOnboarding.logic";
import { SubscriptionStep } from "./OnboardingSubscriptionStep";

/** --ease-smooth-out. Carries the setup surface out over the workspace. */
const SMOOTH_OUT = [0.22, 1, 0.36, 1] as const;

const LEAVE = [0.4, 0, 1, 1] as const;

/** Seconds. Has to match the wait the reveal leaves before it unmounts setup. */
const REVEAL_DURATION = DESKTOP_ONBOARDING_REVEAL_DURATION_MS / 1000;

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export interface DesktopOnboardingSurfaceProps {
  readonly initialDraft: DesktopOnboardingDraft;
  readonly environmentId: EnvironmentId;
  readonly captureMode: boolean;
  readonly onFinished: () => void;
}

export function OnboardingSurface({
  initialDraft,
  environmentId,
  captureMode,
  onFinished,
}: DesktopOnboardingSurfaceProps) {
  const navigate = useNavigate();
  const reducedMotion = useReducedMotion();
  const { t } = useI18n();
  const createBot = useAtomCommand(botEnvironment.create, { reportFailure: false });
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const serverConfig = useAtomValue(primaryServerConfigAtom);
  const projectRefs = useEnvironmentProjectRefs(environmentId);
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const [draft, setDraft] = useState(initialDraft);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [skipConfirmOpen, setSkipConfirmOpen] = useState(false);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const creatingRef = useRef(false);
  const createRequestedRef = useRef(false);
  const revealTimer = useRef<number | null>(null);

  const providerReadiness = useMemo(
    () => resolveDesktopOnboardingCreationReadiness(draft.providerId, providers),
    [draft.providerId, providers],
  );

  const instantHandoff = reducedMotion === true;

  useEffect(
    () => () => {
      if (revealTimer.current !== null) window.clearTimeout(revealTimer.current);
    },
    [],
  );

  useEffect(() => {
    const appRoot = document.getElementById("root");

    if (!appRoot) return;
    const wasInert = appRoot.inert;
    const previousAriaHidden = appRoot.getAttribute("aria-hidden");
    appRoot.inert = true;
    appRoot.setAttribute("aria-hidden", "true");
    surfaceRef.current?.focus();

    const focusableElements = () => {
      const surface = surfaceRef.current;

      if (!surface) return [];

      return Array.from(surface.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (element) =>
          !element.matches(":disabled") &&
          element.tabIndex >= 0 &&
          element.closest('[inert],[aria-hidden="true"]') === null,
      );
    };

    const containFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const surface = surfaceRef.current;

      if (!surface) return;
      const focusable = focusableElements();

      if (focusable.length === 0) {
        event.preventDefault();
        surface.focus();

        return;
      }

      const first = focusable[0];
      const last = focusable.at(-1);
      const active = document.activeElement;

      if (!surface.contains(active) || (event.shiftKey && active === first)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first?.focus();
      }
    };

    document.addEventListener("keydown", containFocus, true);

    return () => {
      document.removeEventListener("keydown", containFocus, true);
      appRoot.inert = wasInert;

      if (previousAriaHidden === null) appRoot.removeAttribute("aria-hidden");
      else appRoot.setAttribute("aria-hidden", previousAriaHidden);
    };
  }, []);

  const updateDraft = useCallback((next: DesktopOnboardingDraft) => {
    setCreateError(null);
    setDraft(next);
    writeDesktopOnboardingDraft(window.localStorage, next);
  }, []);

  const finishToChat = useCallback(
    (botId: string, botName: string) => {
      markDesktopOnboardingFirstChat(window.localStorage, botId);
      markDesktopOnboardingHandoffStarted(window.localStorage, environmentId, botId);
      useRosterStore.getState().selectBot(botId);
      setRevealing(true);

      const opened = () => {
        clearDesktopOnboardingHandoff(window.localStorage);
        revealTimer.current = window.setTimeout(
          () => onFinished(),
          instantHandoff ? 0 : DESKTOP_ONBOARDING_REVEAL_DURATION_MS,
        );
      };

      void navigate({ to: "/bots/$botId", params: { botId }, replace: true }).then(
        opened,
        () => {
          setRevealing(false);
          toastManager.add({
            type: "error",
            title: t("Could not open {name}'s chat. Open it from the roster or reload to retry.", {
              name: botName,
            }),
          });
        },
      );
    },
    [environmentId, instantHandoff, navigate, onFinished, t],
  );

  const create = useCallback(async () => {
    if (creatingRef.current || revealing) return;

    if (providerReadiness.status === "loading") return;

    if (providerReadiness.status !== "ready") {
      createRequestedRef.current = false;
      setCreateError(t("This provider is not ready. Go back and reconnect it."));

      return;
    }

    createRequestedRef.current = false;
    creatingRef.current = true;
    setCreating(true);
    setCreateError(null);

    const takenNames = useRosterStore
      .getState()
      .bots.filter((bot) => bot.archivedAt === null)
      .map((bot) => bot.name);

    const name = draft.name.trim() || pickDesktopOnboardingTeammateName(takenNames);
    const avatar = draft.name.trim() ? draft.avatar : randomBotAvatar();
    const nextDraft = { ...draft, name, avatar };
    updateDraft(nextDraft);

    const projectInput = desktopOnboardingDefaultProjectCreateInput({
      bootstrapped,
      projectCount: projectRefs.length,
      cwd: serverConfig?.cwd ?? null,
      projectId: `project-${randomUUID()}`,
    });

    if (projectInput) {
      const projectResult = await createProject({
        environmentId,
        input: {
          projectId: ProjectId.make(projectInput.projectId),
          title: projectInput.title,
          workspaceRoot: projectInput.workspaceRoot,
        },
      });

      if (Predicate.isTagged(projectResult, "Failure")) {
        creatingRef.current = false;
        setCreating(false);
        setCreateError(t("Could not create your bot."));

        return;
      }
    }

    const botId = BotId.make(`bot-${randomUUID()}`);

    const result = await createBot({
      environmentId,
      input: {
        botId,
        name,
        title: name,
        label: null,
        description: null,
        avatar,
        engine: providerReadiness.engine,
        sandbox: null,
        runtimeMode: DEFAULT_BOT_RUNTIME_MODE,
        groupId: null,
      },
    });

    if (isAtomCommandInterrupted(result)) {
      creatingRef.current = false;
      setCreating(false);

      return;
    }

    if (Predicate.isTagged(result, "Failure")) {
      creatingRef.current = false;
      setCreating(false);
      setCreateError(t("Could not create your bot."));

      return;
    }

    updateDraft({ ...nextDraft, botId });
    finishToChat(botId, name);
  }, [
    bootstrapped,
    createBot,
    createProject,
    draft,
    environmentId,
    finishToChat,
    projectRefs.length,
    providerReadiness,
    revealing,
    serverConfig?.cwd,
    t,
    updateDraft,
  ]);

  const requestCreate = useCallback(() => {
    createRequestedRef.current = true;
    void create();
  }, [create]);

  useEffect(() => {
    if (!createRequestedRef.current || creatingRef.current) return;

    if (providerReadiness.status === "loading") return;
    void create();
  }, [create, providerReadiness.status]);

  const skip = () => {
    setSkipConfirmOpen(false);
    markDesktopOnboardingCompleted(window.localStorage);
    onFinished();
  };

  return createPortal(
    <motion.div
      ref={surfaceRef}
      data-testid="desktop-onboarding"
      role="dialog"
      aria-modal="true"
      aria-label={t("Set up Akeru Bot")}
      tabIndex={-1}
      className={`fixed inset-0 z-10000 flex flex-col overflow-hidden bg-background text-foreground ${
        revealing ? "pointer-events-none" : ""
      }`}
      initial={reducedMotion ? false : { opacity: 0 }}
      animate={{ opacity: revealing ? 0 : 1 }}
      exit={{ opacity: 0, transition: { duration: 0 } }}
      transition={{
        duration: revealing ? (instantHandoff ? 0 : REVEAL_DURATION) : reducedMotion ? 0 : 0.18,
        ease: revealing ? SMOOTH_OUT : LEAVE,
      }}
    >
      <div className="relative z-10 mx-auto flex min-h-0 w-full max-w-xl flex-1 flex-col px-6 pb-6 pt-6 lg:px-10 lg:pb-10 lg:pt-8">
        <span className="text-sm font-semibold tracking-title">Akeru Bot</span>
        <div className="flex min-h-0 flex-1 overflow-y-auto overscroll-contain py-5 pe-1 lg:py-6">
          <div className="my-auto w-full py-4">
            {creating ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <LoaderIcon className="size-4 animate-spin motion-reduce:animate-none" />
                {draft.name.trim()
                  ? t("Setting up {name}", { name: draft.name.trim() })
                  : t("Preparing your provider…")}
              </div>
            ) : (
              <SubscriptionStep
                environmentId={environmentId}
                draft={draft}
                captureMode={captureMode}
                onChange={updateDraft}
                onContinue={requestCreate}
              />
            )}
            {createError ? (
              <p role="alert" className="mt-4 text-sm text-destructive">
                {createError}
              </p>
            ) : null}
            {providerReadiness.status === "loading" && !creating ? (
              <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
                <LoaderIcon className="size-4 animate-spin motion-reduce:animate-none" />
                {t("Preparing your provider…")}
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex items-center justify-end gap-3">
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={creating || revealing}
            onClick={() => setSkipConfirmOpen(true)}
          >
            {t("Skip setup")}
          </Button>
        </div>
      </div>
      <AlertDialog open={skipConfirmOpen} onOpenChange={setSkipConfirmOpen}>
        <AlertDialogPopup portalContainer={surfaceRef}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Skip setup?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("You can connect a subscription and create a bot later.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>{t("Cancel")}</AlertDialogClose>
            <Button onClick={skip}>{t("Skip setup")}</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </motion.div>,
    document.body,
  );
}
