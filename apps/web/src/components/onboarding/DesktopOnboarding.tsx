import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  BotId,
  EnvironmentId,
  type SubscriptionAuthLoginProgress,
  type SubscriptionAuthStartResult,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  ExternalLinkIcon,
  LoaderIcon,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { createPortal } from "react-dom";

import { isElectron } from "../../env";
import { useI18n } from "../../i18n";
import { randomUUID } from "../../lib/utils";
import { botEnvironment, environmentBotsAtom, environmentRosterLoadedAtom } from "../../state/bots";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { environmentShell } from "../../state/shell";
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
import { Input } from "../ui/input";
import { BotAvatarView } from "../roster/BotAvatarView";
import { AvatarColorPicker } from "../roster/AvatarColorPicker";
import { writeBotDraft } from "../roster/botDraftStore";
import { DEFAULT_BOT_RUNTIME_MODE } from "../roster/botSandbox";
import { BLOB_SHAPES } from "../roster/roster.logic";
import { useRosterStore } from "../roster/rosterStore";
import { toastManager } from "../ui/toast";
import { OnboardingGoalStep } from "./OnboardingGoalStep";
import { OnboardingPreview } from "./OnboardingPreview";
import {
  apiKeyStartInput,
  apiKeyValidationError,
  providerSupportsBaseUrl,
} from "@t3tools/client-runtime/provider-auth";
import { ProviderApiKeyForm } from "../settings/ProvidersPanel";
import { SignInCodeCopy } from "../settings/SignInCodeCopy";
import { SUBSCRIPTION_PROVIDERS } from "../settings/subscriptionProviders";
import {
  canStartDesktopOnboardingReveal,
  DEFAULT_DESKTOP_ONBOARDING_DRAFT,
  DESKTOP_ONBOARDING_COMPLETED_STORAGE_KEY,
  DESKTOP_ONBOARDING_DESTINATION_TIMEOUT_MS,
  DESKTOP_ONBOARDING_REVEAL_DURATION_MS,
  DESKTOP_ONBOARDING_STEPS,
  DESKTOP_ONBOARDING_STORAGE_KEY,
  type DesktopOnboardingDraft,
  type DesktopOnboardingStep,
  desktopOnboardingHandoffStages,
  type DesktopOnboardingHandoffPhase,
  desktopOnboardingModelSelection,
  desktopOnboardingProgress,
  clearDesktopOnboardingHandoff,
  markDesktopOnboardingCompleted,
  markDesktopOnboardingHandoffStarted,
  readDesktopOnboardingHandoff,
  readDesktopOnboardingHandoffForEnvironment,
  parseDesktopOnboardingDraft,
  recoverDisappearedDesktopOnboardingBot,
  recoverMissingDesktopOnboardingBot,
  resolveDesktopOnboardingCreationReadiness,
  shouldShowDesktopOnboarding,
  type OnboardingTranslate,
} from "./desktopOnboarding.logic";
import { desktopOnboardingBotBrief } from "./goalPlan.logic";

const NO_ENVIRONMENT = "" as EnvironmentId;
const EASE = [0.23, 1, 0.32, 1] as const;
const LEAVE = [0.4, 0, 1, 1] as const;
/** --ease-smooth-out. Carries the setup surface out over the workspace. */
const SMOOTH_OUT = [0.22, 1, 0.36, 1] as const;
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

function readDraft(): DesktopOnboardingDraft | null {
  return parseDesktopOnboardingDraft(window.localStorage.getItem(DESKTOP_ONBOARDING_STORAGE_KEY));
}

function writeDraft(draft: DesktopOnboardingDraft): void {
  window.localStorage.setItem(DESKTOP_ONBOARDING_STORAGE_KEY, JSON.stringify(draft));
}

function commandError(
  result: Parameters<typeof squashAtomCommandFailure>[0],
  t: OnboardingTranslate,
): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : t("The request failed.");
}

/** Rail label for a setup step. Short enough to sit in a four-up stepper. */
function stepLabel(step: DesktopOnboardingStep, t: OnboardingTranslate): string {
  switch (step) {
    case "subscription":
      return t("Connect");
    case "goal":
      return t("Goal");
    case "identity":
      return t("Identity");
    case "message":
      return t("First message");
  }
}

function readCaptureMode(): boolean {
  return (
    import.meta.env.DEV &&
    new URLSearchParams(window.location.search).get("akeru-onboarding-capture") === "1"
  );
}

interface ActiveLogin {
  readonly flow: SubscriptionAuthStartResult;
  readonly error: string | null;
}

export function SubscriptionStep({
  environmentId,
  draft,
  captureMode = false,
  onChange,
  onContinue,
}: {
  readonly environmentId: EnvironmentId;
  readonly draft: DesktopOnboardingDraft;
  readonly captureMode?: boolean;
  readonly onChange: (draft: DesktopOnboardingDraft) => void;
  readonly onContinue: () => void;
}) {
  const statusQuery = useEnvironmentQuery(
    serverEnvironment.subscriptionAuth({ environmentId, input: {} }),
  );
  const startAuth = useAtomCommand(serverEnvironment.startSubscriptionAuth, {
    reportFailure: false,
  });
  const pollAuth = useAtomCommand(serverEnvironment.pollSubscriptionAuth, {
    reportFailure: false,
  });
  const completeAuth = useAtomCommand(serverEnvironment.completeSubscriptionAuth, {
    reportFailure: false,
  });
  const cancelAuth = useAtomCommand(serverEnvironment.cancelSubscriptionAuth, {
    reportFailure: false,
  });
  const { t } = useI18n();
  const [activeLogin, setActiveLogin] = useState<ActiveLogin | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [keyMode, setKeyMode] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  const statusByProvider = useMemo(
    () => new Map(statusQuery.data?.providers.map((status) => [status.provider, status]) ?? []),
    [statusQuery.data],
  );
  const selected = SUBSCRIPTION_PROVIDERS.find((item) => item.id === draft.providerId)!;
  const connected = captureMode || statusByProvider.get(draft.providerId)?.connected === true;

  const settle = useCallback(
    (progress: SubscriptionAuthLoginProgress) => {
      if (progress.status === "connected") {
        setActiveLogin(null);
        setBusy(false);
        statusQuery.refresh();
        return true;
      }
      if (progress.status === "failed") {
        setActiveLogin((current) => (current ? { ...current, error: progress.error } : current));
        setBusy(false);
      }
      return false;
    },
    [statusQuery],
  );

  useEffect(() => {
    if (!activeLogin || activeLogin.flow.completion !== "poll") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const result = await pollAuth({
        environmentId,
        input: { loginId: activeLogin.flow.loginId },
      });
      if (cancelled || isAtomCommandInterrupted(result)) return;
      if (result._tag === "Failure") {
        setActiveLogin((current) =>
          current ? { ...current, error: commandError(result, t) } : current,
        );
        setBusy(false);
        return;
      }
      if (settle(result.value)) return;
      if (result.value.status === "pending") {
        timer = setTimeout(poll, Math.max(1_000, result.value.nextPollMs));
      }
    };
    timer = setTimeout(poll, 1_000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeLogin, environmentId, pollAuth, settle, t]);

  const openKey = () => {
    setCode("");
    setError(null);
    setBaseUrl(statusByProvider.get(draft.providerId)?.baseUrl ?? "");
    setKeyMode(true);
  };

  const saveKey = async () => {
    if (busy) return;
    const validation = apiKeyValidationError(code, baseUrl);
    setError(validation);
    if (validation) return;
    setBusy(true);
    const started = await startAuth({
      environmentId,
      input: apiKeyStartInput(draft.providerId, baseUrl),
    });
    if (started._tag !== "Success") {
      setBusy(false);
      if (started._tag === "Failure") setError(commandError(started, t));
      return;
    }
    const result = await completeAuth({
      environmentId,
      input: { loginId: started.value.loginId, code: code.trim() },
    });
    if (result._tag === "Success" && result.value.status === "connected") {
      setCode("");
      setBaseUrl("");
      setKeyMode(false);
      setBusy(false);
      statusQuery.refresh();
      onContinue();
      return;
    }
    if (result._tag === "Failure") setError(commandError(result, t));
    else if (result._tag === "Success") {
      setError(
        result.value.status === "failed"
          ? result.value.error
          : t("The key was not saved. Try again."),
      );
    }
    await cancelAuth({ environmentId, input: { loginId: started.value.loginId } });
    setBusy(false);
  };

  const connect = async () => {
    if (draft.providerId === "opencode-go" && !captureMode) {
      openKey();
      return;
    }
    if (captureMode) {
      onContinue();
      return;
    }
    setError(null);
    setCode("");
    setBusy(true);
    const result = await startAuth({
      environmentId,
      input: { provider: draft.providerId },
    });
    if (isAtomCommandInterrupted(result)) {
      setBusy(false);
      return;
    }
    if (result._tag === "Failure") {
      setError(commandError(result, t));
      setBusy(false);
      return;
    }
    setBusy(false);
    setActiveLogin({ flow: result.value, error: null });
    window.open(result.value.url, "_blank", "noopener,noreferrer");
  };

  const complete = async () => {
    if (!activeLogin) return;
    setBusy(true);
    const result = await completeAuth({
      environmentId,
      input: { loginId: activeLogin.flow.loginId, code },
    });
    if (isAtomCommandInterrupted(result)) {
      setBusy(false);
      return;
    }
    if (result._tag === "Failure") {
      setActiveLogin((current) =>
        current ? { ...current, error: commandError(result, t) } : current,
      );
      setBusy(false);
      return;
    }
    settle(result.value);
  };

  const cancel = async () => {
    const login = activeLogin;
    setActiveLogin(null);
    setBusy(false);
    setCode("");
    if (login) {
      await cancelAuth({ environmentId, input: { loginId: login.flow.loginId } });
    }
  };

  if (keyMode) {
    return (
      <div className="space-y-4">
        <h1 className="text-balance text-[1.75rem] font-medium leading-[1.1] tracking-[-0.035em] lg:text-[2rem] lg:leading-[1.08]">
          {t("Connect {provider} with an API key", { provider: selected.label })}
        </h1>
        <ProviderApiKeyForm
          supportsBaseUrl={providerSupportsBaseUrl(draft.providerId)}
          apiKey={code}
          baseUrl={baseUrl}
          busy={busy}
          error={error}
          onKeyChange={setCode}
          onBaseUrlChange={setBaseUrl}
          onSave={() => void saveKey()}
          onCancel={() => {
            setKeyMode(false);
            setCode("");
            setBaseUrl("");
            setError(null);
          }}
        />
      </div>
    );
  }

  if (activeLogin) {
    return (
      <div className="space-y-4">
        <h1 className="text-balance text-[1.75rem] font-medium leading-[1.1] tracking-[-0.035em] lg:text-[2rem] lg:leading-[1.08]">
          {t("Finish connecting {provider}", { provider: selected.label })}
        </h1>
        <p className="text-sm leading-6 text-muted-foreground">
          {activeLogin.flow.instructions ?? t("Finish signing in on the provider page.")}
        </p>
        {activeLogin.flow.userCode ? (
          <SignInCodeCopy
            code={activeLogin.flow.userCode}
            className="rounded-xl border border-border/70 bg-background/60 py-2.5"
          />
        ) : null}
        {activeLogin.flow.completion === "paste" ? (
          <div className="space-y-2">
            <Input
              value={code}
              onChange={(event) => setCode(event.currentTarget.value)}
              placeholder={t("Paste authorization code")}
              aria-label={t("Authorization code")}
            />
            <Button
              className="w-full"
              disabled={!code.trim() || busy}
              onClick={() => void complete()}
            >
              {busy ? (
                <LoaderIcon className="size-4 animate-spin motion-reduce:animate-none" />
              ) : null}
              {t("Connect")}
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderIcon className="size-4 animate-spin motion-reduce:animate-none" />
            {t("Waiting for approval")}
          </div>
        )}
        {activeLogin.error ? <p className="text-sm text-destructive">{activeLogin.error}</p> : null}
        <div className="flex gap-2">
          <Button
            className="flex-1"
            variant="outline"
            render={<a href={activeLogin.flow.url} target="_blank" rel="noreferrer" />}
          >
            {t("Open sign-in")} <ExternalLinkIcon className="size-4" />
          </Button>
          <Button variant="ghost-muted" onClick={() => void cancel()}>
            {t("Cancel")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-balance text-[1.75rem] font-medium leading-[1.1] tracking-[-0.035em] lg:text-[2rem] lg:leading-[1.08]">
          {t("Connect your provider")}
        </h1>
      </div>
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t("Provider")}>
        {SUBSCRIPTION_PROVIDERS.map((definition) => {
          const active = definition.id === draft.providerId;
          const ProviderIcon = typeof definition.icon === "string" ? null : definition.icon;
          const providerConnected = captureMode
            ? active
            : statusByProvider.get(definition.id)?.connected === true;
          return (
            <button
              key={definition.id}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={busy}
              onClick={() => onChange({ ...draft, providerId: definition.id })}
              className={`relative flex min-h-24 flex-col items-start rounded-2xl border p-3 text-left transition duration-150 motion-reduce:transition-none ${
                active
                  ? "border-foreground/30 bg-foreground/[0.06] shadow-sm"
                  : "border-border/65 bg-background/35 hover:bg-foreground/[0.035]"
              }`}
            >
              <div className="flex w-full items-center justify-between">
                <span className="flex size-8 items-center justify-center rounded-lg border border-border/60 bg-background/70">
                  {ProviderIcon ? (
                    <ProviderIcon className="size-4" />
                  ) : (
                    <img
                      src={definition.icon as string}
                      alt=""
                      className="size-4 brightness-0 dark:invert"
                    />
                  )}
                </span>
                {providerConnected ? (
                  <span className="flex size-5 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                    <CheckIcon className="size-3" />
                  </span>
                ) : null}
              </div>
              <span className="mt-2 text-sm font-medium">{definition.label}</span>
              <span className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                {t(definition.subscription)}
              </span>
            </button>
          );
        })}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {!connected && selected.id !== "opencode-go" ? (
        <Button className="w-full" variant="outline" disabled={busy} onClick={openKey}>
          {t("Use an API key")}
        </Button>
      ) : null}
      <Button
        className="h-10 w-full rounded-xl"
        disabled={busy}
        onClick={connected ? onContinue : () => void connect()}
      >
        {busy ? <LoaderIcon className="size-4 animate-spin motion-reduce:animate-none" /> : null}
        {connected ? t("Continue") : t("Connect {provider}", { provider: selected.label })}
        {!busy ? <ArrowRightIcon className="size-4" /> : null}
      </Button>
    </div>
  );
}

function IdentityStep({
  draft,
  creating,
  providerReadiness,
  error,
  onChange,
  onBack,
  onContinue,
}: {
  readonly draft: DesktopOnboardingDraft;
  readonly creating: boolean;
  readonly providerReadiness: ReturnType<typeof resolveDesktopOnboardingCreationReadiness>;
  readonly error: string | null;
  readonly onChange: (draft: DesktopOnboardingDraft) => void;
  readonly onBack: () => void;
  readonly onContinue: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-balance text-[1.75rem] font-medium leading-[1.1] tracking-[-0.035em] lg:text-[2rem] lg:leading-[1.08]">
          {t("Give it a name")}
        </h1>
        <p className="text-sm leading-6 text-muted-foreground">
          {t("You will call on this bot by name every day. Pick one that sounds like a teammate.")}
        </p>
      </div>
      <label className="flex w-full flex-col gap-2 text-sm font-medium">
        {t("Name")}
        <Input
          autoFocus
          size="lg"
          value={draft.name}
          maxLength={80}
          placeholder={t("Nova, Scout, Dispatch…")}
          onChange={(event) => onChange({ ...draft, name: event.currentTarget.value })}
        />
      </label>
      <section aria-label={t("Avatar")} className="space-y-5 border-t pt-5">
        <div className="space-y-3">
          <h2 className="text-xs font-medium text-muted-foreground">{t("Shape")}</h2>
          <div className="grid grid-cols-8 gap-1.5">
            {BLOB_SHAPES.map((shape) => (
              <button
                key={shape}
                type="button"
                aria-label={t("{shape} avatar", { shape })}
                aria-pressed={draft.avatar.shape === shape}
                onClick={() => onChange({ ...draft, avatar: { ...draft.avatar, shape } })}
                className={`flex aspect-square items-center justify-center rounded-lg border border-transparent outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none ${
                  draft.avatar.shape === shape ? "border-border bg-accent" : "hover:bg-accent/60"
                }`}
              >
                <BotAvatarView
                  avatar={{ ...draft.avatar, shape }}
                  name={draft.name || t("Bot")}
                  className="size-7"
                />
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-3">
          <h2 className="text-xs font-medium text-muted-foreground">{t("Color")}</h2>
          <AvatarColorPicker
            value={draft.avatar.color}
            onChange={(color) => onChange({ ...draft, avatar: { ...draft.avatar, color } })}
          />
        </div>
      </section>
      {providerReadiness.status === "loading" ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderIcon className="size-4 animate-spin motion-reduce:animate-none" />
          {t("Preparing your provider…")}
        </p>
      ) : providerReadiness.status === "unavailable" ? (
        <p className="text-sm text-destructive">
          {t("This provider is not ready. Go back and reconnect it.")}
        </p>
      ) : error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : null}
      <div className="flex gap-2">
        <Button size="icon" variant="ghost-muted" aria-label={t("Back")} onClick={onBack}>
          <ArrowLeftIcon className="size-4" />
        </Button>
        <Button
          className="h-10 flex-1 rounded-xl"
          disabled={!draft.name.trim() || creating || providerReadiness.status !== "ready"}
          onClick={onContinue}
        >
          {creating ? (
            <LoaderIcon className="size-4 animate-spin motion-reduce:animate-none" />
          ) : null}
          {t("Continue")}
          {!creating ? <ArrowRightIcon className="size-4" /> : null}
        </Button>
      </div>
    </div>
  );
}

function OnboardingSurface({
  initialDraft,
  environmentId,
  captureMode,
  onFinished,
}: DesktopOnboardingSurfaceProps) {
  const navigate = useNavigate();
  const reducedMotion = useReducedMotion();
  const { t } = useI18n();
  const createBot = useAtomCommand(botEnvironment.create, { reportFailure: false });
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const [draft, setDraft] = useState(initialDraft);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [handoff, setHandoff] = useState<DesktopOnboardingHandoffPhase | null>(null);
  /** The chat route has committed, so the workspace is the layer behind setup. */
  const [routeOpened, setRouteOpened] = useState(false);
  /** The sent message and its turn are in the state the chat renders from. */
  const [messageObserved, setMessageObserved] = useState(false);
  const [revealTimedOut, setRevealTimedOut] = useState(false);
  const observeDestination = useCallback(() => setMessageObserved(true), []);
  const [skipConfirmOpen, setSkipConfirmOpen] = useState(false);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const handoffTimers = useRef<number[]>([]);
  const readyBotIdRef = useRef<string | null>(null);
  const rosterBot = useRosterStore((state) =>
    draft.botId ? state.bots.find((bot) => bot.id === draft.botId) : undefined,
  );
  const providerReadiness = useMemo(
    () => resolveDesktopOnboardingCreationReadiness(draft.providerId, providers),
    [draft.providerId, providers],
  );

  /** Reduced motion skips the handoff choreography and reveals at once. */
  const instantHandoff = reducedMotion === true;

  useEffect(
    () => () => {
      for (const timer of handoffTimers.current) window.clearTimeout(timer);
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

  useEffect(() => {
    if (draft.step !== "message" || draft.botId === null) {
      readyBotIdRef.current = null;
      return;
    }
    if (rosterBot) {
      readyBotIdRef.current = draft.botId;
      return;
    }
    const recoveredDraft = recoverDisappearedDesktopOnboardingBot(draft, readyBotIdRef.current);
    if (recoveredDraft === draft) return;
    readyBotIdRef.current = null;
    setDraft(recoveredDraft);
    writeDraft(recoveredDraft);
  }, [draft, rosterBot]);

  const updateDraft = (next: DesktopOnboardingDraft) => {
    setCreateError(null);
    setDraft(next);
    writeDraft(next);
  };

  const create = async () => {
    setCreating(true);
    setCreateError(null);
    const botId = BotId.make(`bot-${randomUUID()}`);
    const goal = desktopOnboardingBotBrief(draft.goal);
    if (providerReadiness.status !== "ready") {
      setCreating(false);
      return;
    }
    const result = await createBot({
      environmentId,
      input: {
        botId,
        name: draft.name.trim(),
        title: "Assistant",
        label: null,
        description: goal.description,
        avatar: draft.avatar,
        engine: providerReadiness.engine,
        sandbox: null,
        runtimeMode: DEFAULT_BOT_RUNTIME_MODE,
        usageCap: null,
        groupId: null,
      },
    });
    setCreating(false);
    if (isAtomCommandInterrupted(result)) return;
    if (result._tag === "Failure") {
      setCreateError(t("Could not create your bot."));
      return;
    }
    writeBotDraft(`onboarding:${botId}`, goal.prompt);
    updateDraft({ ...draft, step: "message", botId });
  };

  /**
   * Whether the workspace behind setup is showing the chat the user just
   * started: the chat route has committed and the sent message is visible in
   * the state that route renders from. Capture mode never sends, so it only
   * waits for the route. A draft with no bot has no destination to wait on.
   * Setup cannot reach the send without one, but the overlay still has to
   * lift if it ever does.
   */
  const destinationReady =
    draft.botId === null || (routeOpened && (captureMode || messageObserved));

  /**
   * Hands the user from setup to the workspace. The message lands, the bot
   * wakes, and the workspace is opened behind setup, which stays fully opaque
   * until that workspace is genuinely showing the conversation. A clock cannot
   * know when a projection arrives, so nothing here guesses at one.
   */
  const finish = (firstMessage: string) => {
    setMessage(firstMessage);
    setHandoff("sending");
    if (draft.botId)
      markDesktopOnboardingHandoffStarted(window.localStorage, environmentId, draft.botId);
    else markDesktopOnboardingCompleted(window.localStorage);
    for (const stage of desktopOnboardingHandoffStages(instantHandoff)) {
      if (stage.phase === "sending") continue;
      handoffTimers.current.push(
        window.setTimeout(() => {
          if (stage.phase !== "opening" || !draft.botId) {
            setHandoff(stage.phase);
            return;
          }
          const pending = readDesktopOnboardingHandoff(window.localStorage);
          if (pending?.environmentId !== environmentId || pending.botId !== draft.botId) {
            onFinished();
            return;
          }
          setHandoff(stage.phase);
          useRosterStore.getState().selectBot(draft.botId);
          const opened = () => {
            clearDesktopOnboardingHandoff(window.localStorage);
            setRouteOpened(true);
          };
          void navigate({ to: "/bots/$botId", params: { botId: draft.botId }, replace: true }).then(
            opened,
            () =>
              toastManager.add({
                type: "error",
                title: `Could not open ${draft.name}'s chat. Open it from the roster or reload to retry.`,
              }),
          );
        }, stage.atMs),
      );
    }
    // Failure safety, never the normal path: a destination that never reports
    // itself (a stalled projection, a dropped socket) must not leave the
    // user stuck behind an overlay that will not lift.
    handoffTimers.current.push(
      window.setTimeout(() => setRevealTimedOut(true), DESKTOP_ONBOARDING_DESTINATION_TIMEOUT_MS),
    );
  };

  /**
   * The reveal. It starts from readiness rather than from the send, so the
   * fade always lands on a painted conversation, and it owns the rest of the
   * handoff: setup unmounts on the fade's last frame, never before it.
   */
  useEffect(() => {
    if (
      !canStartDesktopOnboardingReveal({
        phase: handoff,
        destinationReady,
        timedOut: revealTimedOut,
      })
    ) {
      return;
    }
    setHandoff("revealing");
    handoffTimers.current.push(
      window.setTimeout(
        () => {
          setHandoff("done");
          onFinished();
        },
        instantHandoff ? 0 : DESKTOP_ONBOARDING_REVEAL_DURATION_MS,
      ),
    );
  }, [destinationReady, handoff, instantHandoff, onFinished, revealTimedOut]);

  const skip = () => {
    setSkipConfirmOpen(false);
    markDesktopOnboardingCompleted(window.localStorage);
    onFinished();
  };

  const progress = desktopOnboardingProgress(draft.step);
  // Page-side-by-side with the exit slide switched off. The workspace mounts
  // behind setup at `opening` and paints while setup still covers it, then the
  // whole surface fades off it as one opaque layer. Nothing inside animates
  // out, so no piece of setup reads as leaving on its own.
  const revealing = handoff === "revealing" || handoff === "done";
  return createPortal(
    <motion.div
      ref={surfaceRef}
      data-testid="desktop-onboarding"
      role="dialog"
      aria-modal="true"
      aria-label={t("Set up Akeru Bot")}
      tabIndex={-1}
      className="fixed inset-0 z-[10000] flex flex-col overflow-hidden bg-background text-foreground lg:flex-row"
      style={{ pointerEvents: revealing ? "none" : "auto" }}
      initial={reducedMotion ? false : { opacity: 0 }}
      animate={{ opacity: revealing ? 0 : 1 }}
      // The reveal fade already took the surface to nothing, and `done` fires
      // the instant it lands, so unmounting has nothing left to animate.
      exit={{ opacity: 0, transition: { duration: 0 } }}
      transition={{
        duration: revealing ? (instantHandoff ? 0 : REVEAL_DURATION) : reducedMotion ? 0 : 0.18,
        ease: revealing ? SMOOTH_OUT : LEAVE,
      }}
    >
      <aside className="relative z-10 flex min-h-0 w-full min-w-0 flex-1 flex-col border-b border-border/70 bg-card/45 px-6 pb-6 pt-6 backdrop-blur-xl lg:w-[38%] lg:min-w-[380px] lg:max-w-[540px] lg:flex-none lg:border-b-0 lg:border-r lg:px-10 lg:pb-10 lg:pt-8">
        <div className="space-y-5">
          <span className="text-sm font-semibold tracking-[-0.015em]">Akeru Bot</span>
          <ol className="flex items-start gap-2" aria-label={t("Setup steps")}>
            {DESKTOP_ONBOARDING_STEPS.map((definition, index) => {
              const position = index + 1;
              const current = position === progress.number;
              const reached = position <= progress.number;
              return (
                <li
                  key={definition.id}
                  className="flex min-w-0 flex-1 flex-col gap-1.5"
                  aria-current={current ? "step" : undefined}
                >
                  <span
                    className={`h-1 rounded-full transition-colors duration-300 motion-reduce:transition-none ${
                      reached ? "bg-foreground" : "bg-foreground/15"
                    }`}
                  />
                  <span
                    className={`truncate text-[11px] leading-4 transition-colors duration-300 motion-reduce:transition-none ${
                      current ? "font-medium text-foreground" : "text-muted-foreground"
                    }`}
                  >
                    {stepLabel(definition.id, t)}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
        <div className="flex min-h-0 flex-1 overflow-y-auto overscroll-contain py-5 pe-1 lg:py-6">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={draft.step}
              className="my-auto w-full py-4"
              initial={reducedMotion ? false : { opacity: 0, x: 18 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -12 }}
              transition={{ duration: reducedMotion ? 0 : 0.24, ease: EASE }}
            >
              {draft.step === "subscription" ? (
                <SubscriptionStep
                  environmentId={environmentId}
                  draft={draft}
                  captureMode={captureMode}
                  onChange={updateDraft}
                  onContinue={() => updateDraft({ ...draft, step: "goal" })}
                />
              ) : draft.step === "goal" ? (
                <OnboardingGoalStep
                  draft={draft}
                  onChange={updateDraft}
                  onBack={() => updateDraft({ ...draft, step: "subscription" })}
                  onContinue={() => updateDraft({ ...draft, step: "identity" })}
                />
              ) : draft.step === "identity" ? (
                <IdentityStep
                  draft={draft}
                  creating={creating}
                  providerReadiness={providerReadiness}
                  error={createError}
                  onChange={updateDraft}
                  onBack={() => updateDraft({ ...draft, step: "goal" })}
                  onContinue={() => void create()}
                />
              ) : (
                <div className="space-y-4">
                  <h1 className="text-balance text-[1.75rem] font-medium leading-[1.1] tracking-[-0.035em] lg:text-[2rem] lg:leading-[1.08]">
                    {t("Say hello to {name}", { name: draft.name })}
                  </h1>
                  <p className="text-sm leading-6 text-muted-foreground">
                    {t(
                      "Your goal and the plan for it, written out. Edit it however you like, then send. This is the real conversation, not a demo.",
                    )}
                  </p>
                  {!rosterBot ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <LoaderIcon className="size-4 animate-spin motion-reduce:animate-none" />
                      {t("Waking up {name}", { name: draft.name })}
                    </div>
                  ) : null}
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {t("Step {number} of {total}", { number: progress.number, total: progress.total })}
          </p>
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={creating || handoff !== null}
            onClick={() => setSkipConfirmOpen(true)}
          >
            {t("Skip setup")}
          </Button>
        </div>
      </aside>
      <div
        className={`min-h-0 min-w-0 flex-1 ${draft.step === "message" ? "flex" : "hidden lg:flex"}`}
      >
        <OnboardingPreview
          draft={draft}
          message={message}
          createdBotReady={rosterBot !== undefined}
          captureMode={captureMode}
          handoff={handoff}
          modelSelection={desktopOnboardingModelSelection(rosterBot?.engine ?? null)}
          onMessageSent={finish}
          onDestinationReady={observeDestination}
        />
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

interface DesktopOnboardingSurfaceProps {
  readonly initialDraft: DesktopOnboardingDraft;
  readonly environmentId: EnvironmentId;
  readonly captureMode: boolean;
  readonly onFinished: () => void;
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

  // A reload between sending the first message and opening its chat lands
  // here with setup already complete. Finish the trip to that chat once.
  useEffect(() => {
    if (!environmentId || !rosterLoaded) return;
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
  }, [environmentId, navigate, rosterLoaded, serverBots]);

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
