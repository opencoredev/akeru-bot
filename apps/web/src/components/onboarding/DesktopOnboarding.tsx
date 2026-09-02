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
  CopyIcon,
  ExternalLinkIcon,
  LoaderIcon,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isElectron } from "../../env";
import { randomUUID } from "../../lib/utils";
import { botEnvironment, environmentBotsAtom, environmentRosterLoadedAtom } from "../../state/bots";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { primaryServerProvidersAtom, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { BotAvatarView } from "../roster/BotAvatarView";
import { BotPromptComposer } from "../roster/BotPromptComposer";
import { writeBotDraft } from "../roster/botDraftStore";
import { DEFAULT_BOT_RUNTIME_MODE } from "../roster/botSandbox";
import { BLOB_COLORS, BLOB_SHAPES } from "../roster/roster.logic";
import { useRosterStore } from "../roster/rosterStore";
import { useBotThreadRuntime } from "../roster/useBotThreadRuntime";
import { SUBSCRIPTION_PROVIDERS } from "../settings/subscriptionProviders";
import {
  DEFAULT_DESKTOP_ONBOARDING_DRAFT,
  DESKTOP_ONBOARDING_COMPLETED_STORAGE_KEY,
  DESKTOP_ONBOARDING_STORAGE_KEY,
  DESKTOP_ONBOARDING_USE_CASES,
  type DesktopOnboardingDraft,
  desktopOnboardingModelSelection,
  parseDesktopOnboardingDraft,
  recoverMissingDesktopOnboardingBot,
  resolveDesktopOnboardingEngine,
  resolveDesktopOnboardingUseCase,
  shouldShowDesktopOnboarding,
  stepNumber,
} from "./desktopOnboarding.logic";

const NO_ENVIRONMENT = "" as EnvironmentId;
const EASE = [0.23, 1, 0.32, 1] as const;
const LEAVE = [0.4, 0, 1, 1] as const;

function readDraft(): DesktopOnboardingDraft | null {
  return parseDesktopOnboardingDraft(window.localStorage.getItem(DESKTOP_ONBOARDING_STORAGE_KEY));
}

function writeDraft(draft: DesktopOnboardingDraft): void {
  window.localStorage.setItem(DESKTOP_ONBOARDING_STORAGE_KEY, JSON.stringify(draft));
}

function commandError(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "The request failed.";
}

function useCaptureMode(): boolean {
  return (
    import.meta.env.DEV &&
    new URLSearchParams(window.location.search).get("akeru-onboarding-capture") === "1"
  );
}

interface ActiveLogin {
  readonly flow: SubscriptionAuthStartResult;
  readonly error: string | null;
}

function SubscriptionStep({
  environmentId,
  draft,
  onChange,
  onContinue,
}: {
  readonly environmentId: EnvironmentId;
  readonly draft: DesktopOnboardingDraft;
  readonly onChange: (draft: DesktopOnboardingDraft) => void;
  readonly onContinue: () => void;
}) {
  const captureMode = useCaptureMode();
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
  const [activeLogin, setActiveLogin] = useState<ActiveLogin | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");

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
          current ? { ...current, error: commandError(result) } : current,
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
  }, [activeLogin, environmentId, pollAuth, settle]);

  const connect = async () => {
    if (captureMode) {
      onContinue();
      return;
    }
    setBusy(true);
    const result = await startAuth({
      environmentId,
      input: { provider: draft.providerId },
    });
    if (isAtomCommandInterrupted(result)) return;
    if (result._tag === "Failure") {
      setBusy(false);
      return;
    }
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
    if (isAtomCommandInterrupted(result)) return;
    if (result._tag === "Failure") {
      setActiveLogin((current) =>
        current ? { ...current, error: commandError(result) } : current,
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

  if (activeLogin) {
    return (
      <div className="space-y-4">
        <h1 className="text-balance text-[2rem] font-medium leading-[1.08] tracking-[-0.035em]">
          Finish connecting {selected.label}
        </h1>
        <p className="text-sm leading-6 text-muted-foreground">
          {activeLogin.flow.instructions ?? "Finish signing in on the provider page."}
        </p>
        {activeLogin.flow.userCode ? (
          <div className="flex items-center gap-2 rounded-xl border border-border/70 bg-background/60 px-3 py-2.5">
            <code className="flex-1 text-sm font-semibold tracking-[0.18em]">
              {activeLogin.flow.userCode}
            </code>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Copy sign-in code"
              onClick={() => void navigator.clipboard.writeText(activeLogin.flow.userCode ?? "")}
            >
              <CopyIcon className="size-3.5" />
            </Button>
          </div>
        ) : null}
        {activeLogin.flow.completion === "paste" ? (
          <div className="space-y-2">
            <Input
              value={code}
              onChange={(event) => setCode(event.currentTarget.value)}
              placeholder="Paste authorization code"
              aria-label="Authorization code"
            />
            <Button
              className="w-full"
              disabled={!code.trim() || busy}
              onClick={() => void complete()}
            >
              {busy ? (
                <LoaderIcon className="size-4 animate-spin motion-reduce:animate-none" />
              ) : null}
              Connect
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderIcon className="size-4 animate-spin motion-reduce:animate-none" />
            Waiting for approval
          </div>
        )}
        {activeLogin.error ? <p className="text-sm text-destructive">{activeLogin.error}</p> : null}
        <div className="flex gap-2">
          <Button
            className="flex-1"
            variant="outline"
            render={<a href={activeLogin.flow.url} target="_blank" rel="noreferrer" />}
          >
            Open sign-in <ExternalLinkIcon className="size-4" />
          </Button>
          <Button variant="ghost-muted" onClick={() => void cancel()}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-balance text-[2rem] font-medium leading-[1.08] tracking-[-0.035em]">
          Connect your subscription
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Use an account you already pay for. Akeru keeps the login on this Mac.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Subscription">
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
                {definition.subscription}
              </span>
            </button>
          );
        })}
      </div>
      <Button
        className="h-10 w-full rounded-xl"
        disabled={busy}
        onClick={connected ? onContinue : () => void connect()}
      >
        {busy ? <LoaderIcon className="size-4 animate-spin motion-reduce:animate-none" /> : null}
        {connected ? "Continue" : `Connect ${selected.label}`}
        {!busy ? <ArrowRightIcon className="size-4" /> : null}
      </Button>
    </div>
  );
}

function IdentityStep({
  draft,
  creating,
  error,
  onChange,
  onBack,
  onContinue,
}: {
  readonly draft: DesktopOnboardingDraft;
  readonly creating: boolean;
  readonly error: string | null;
  readonly onChange: (draft: DesktopOnboardingDraft) => void;
  readonly onBack: () => void;
  readonly onContinue: () => void;
}) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-balance text-[2rem] font-medium leading-[1.08] tracking-[-0.035em]">
          Make it yours
        </h1>
      </div>
      <div className="flex flex-col items-center gap-4">
        <BotAvatarView
          avatar={draft.avatar}
          name={draft.name || "Your bot"}
          className="size-20 shrink-0"
        />
        <label className="flex w-full flex-col gap-2 text-sm font-medium">
          Name
          <Input
            autoFocus
            size="lg"
            value={draft.name}
            maxLength={80}
            placeholder="Name your bot"
            onChange={(event) => onChange({ ...draft, name: event.currentTarget.value })}
          />
        </label>
      </div>
      <section aria-label="Avatar" className="space-y-5 border-t pt-5">
        <div className="space-y-3">
          <h2 className="text-center text-xs font-medium text-muted-foreground">Shape</h2>
          <div className="mx-auto grid w-fit max-w-full grid-cols-8 gap-1.5">
            {BLOB_SHAPES.map((shape) => (
              <button
                key={shape}
                type="button"
                aria-label={`${shape} avatar`}
                aria-pressed={draft.avatar.shape === shape}
                onClick={() => onChange({ ...draft, avatar: { ...draft.avatar, shape } })}
                className={`flex size-9 items-center justify-center rounded-lg border border-transparent outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none ${
                  draft.avatar.shape === shape ? "border-border bg-accent" : "hover:bg-accent/60"
                }`}
              >
                <BotAvatarView
                  avatar={{ ...draft.avatar, shape }}
                  name={draft.name || "Bot"}
                  className="size-7"
                />
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-3">
          <h2 className="text-center text-xs font-medium text-muted-foreground">Color</h2>
          <div className="mx-auto grid w-fit grid-cols-5 gap-3">
            {BLOB_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                aria-label={`${color} avatar color`}
                aria-pressed={draft.avatar.color === color}
                onClick={() => onChange({ ...draft, avatar: { ...draft.avatar, color } })}
                className={`size-8 rounded-full border border-foreground/10 outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none ${
                  draft.avatar.color === color
                    ? "ring-2 ring-ring ring-offset-2 ring-offset-background"
                    : ""
                }`}
                style={{ backgroundColor: color }}
              />
            ))}
          </div>
        </div>
      </section>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <div className="flex gap-2">
        <Button size="icon" variant="ghost-muted" aria-label="Back" onClick={onBack}>
          <ArrowLeftIcon className="size-4" />
        </Button>
        <Button
          className="h-10 flex-1 rounded-xl"
          disabled={!draft.name.trim() || creating}
          onClick={onContinue}
        >
          {creating ? (
            <LoaderIcon className="size-4 animate-spin motion-reduce:animate-none" />
          ) : null}
          Continue
          {!creating ? <ArrowRightIcon className="size-4" /> : null}
        </Button>
      </div>
    </div>
  );
}

function UseCaseStep({
  draft,
  onChange,
  onBack,
  onContinue,
}: {
  readonly draft: DesktopOnboardingDraft;
  readonly onChange: (draft: DesktopOnboardingDraft) => void;
  readonly onBack: () => void;
  readonly onContinue: () => void;
}) {
  return (
    <div className="space-y-6">
      <h1 className="text-balance text-[2rem] font-medium leading-[1.08] tracking-[-0.035em]">
        What should it help with?
      </h1>
      <div className="grid gap-2" role="radiogroup" aria-label="First use case">
        {DESKTOP_ONBOARDING_USE_CASES.map((useCase) => {
          const selected = useCase.id === draft.useCaseId;
          return (
            <button
              key={useCase.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange({ ...draft, useCaseId: useCase.id })}
              className={`rounded-xl border px-4 py-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none ${
                selected
                  ? "border-foreground/30 bg-foreground/[0.06]"
                  : "border-border/65 bg-background/35 hover:bg-foreground/[0.035]"
              }`}
            >
              <span className="block text-sm font-medium">{useCase.label}</span>
              <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                {useCase.description}
              </span>
            </button>
          );
        })}
        {draft.useCaseId === "custom" ? (
          <Input
            autoFocus
            value={draft.customUseCase}
            maxLength={240}
            placeholder="What should your bot do?"
            aria-label="Custom use case"
            onChange={(event) => onChange({ ...draft, customUseCase: event.currentTarget.value })}
          />
        ) : null}
      </div>
      <div className="flex gap-2">
        <Button size="icon" variant="ghost-muted" aria-label="Back" onClick={onBack}>
          <ArrowLeftIcon className="size-4" />
        </Button>
        <Button
          className="h-10 flex-1 rounded-xl"
          disabled={draft.useCaseId === "custom" && !draft.customUseCase.trim()}
          onClick={onContinue}
        >
          Continue
          <ArrowRightIcon className="size-4" />
        </Button>
      </div>
    </div>
  );
}

function FirstMessageComposer({
  botId,
  botName,
  captureMode,
  modelSelection,
  onComplete,
}: {
  readonly botId: string;
  readonly botName: string;
  readonly captureMode: boolean;
  readonly modelSelection: ReturnType<typeof desktopOnboardingModelSelection>;
  readonly onComplete: (message: string) => void;
}) {
  const runtime = useBotThreadRuntime(botId, modelSelection);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="w-full">
      <BotPromptComposer
        botName={botName}
        draftKey={`onboarding:${botId}`}
        disabled={!captureMode && (!runtime.botReady || runtime.defaultProject === null)}
        onSubmit={async (prompt, files) => {
          if (captureMode) {
            onComplete(prompt);
            return true;
          }
          const sent = await runtime.send(prompt, files);
          if (!sent) {
            setError(runtime.error ?? "Could not send the message.");
            return false;
          }
          onComplete(prompt);
          return true;
        }}
      />
      {error ? <p className="px-5 pt-2 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function ConversationPreview({
  draft,
  message,
  createdBotReady,
  modelSelection,
  onMessageSent,
}: {
  readonly draft: DesktopOnboardingDraft;
  readonly message: string | null;
  readonly createdBotReady: boolean;
  readonly modelSelection: ReturnType<typeof desktopOnboardingModelSelection>;
  readonly onMessageSent: (message: string) => void;
}) {
  const captureMode = useCaptureMode();
  const messageStep = draft.step === "message";
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border/65 px-5">
        <BotAvatarView avatar={draft.avatar} name={draft.name || "Your bot"} className="size-7" />
        <span className="truncate text-sm font-medium">{draft.name || "Your bot"}</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 items-center justify-center px-8">
          {message ? (
            <div className="w-full max-w-2xl space-y-8">
              <div className="ml-auto max-w-[78%] rounded-2xl rounded-br-md bg-foreground px-4 py-3 text-sm text-background shadow-sm">
                {message}
              </div>
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <BotAvatarView
                  avatar={draft.avatar}
                  name={draft.name}
                  state="working"
                  className="size-7"
                />
                <span>{draft.name} is getting started</span>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center text-center">
              <motion.div
                layout
                transition={{ duration: 0.35, ease: EASE }}
                className="flex size-24 items-center justify-center rounded-[2rem] border border-border/55 bg-card/35 shadow-[0_24px_70px_-36px_rgba(0,0,0,0.45)]"
              >
                <BotAvatarView
                  avatar={draft.avatar}
                  name={draft.name || "Your bot"}
                  className="size-16"
                />
              </motion.div>
              <motion.h2 layout className="mt-5 text-xl font-medium tracking-[-0.02em]">
                {draft.name || "Your bot"}
              </motion.h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {messageStep ? "Send the first message" : "Your bot is taking shape"}
              </p>
            </div>
          )}
        </div>
        <div className="shrink-0 pb-5">
          {messageStep && draft.botId && createdBotReady ? (
            <FirstMessageComposer
              botId={draft.botId}
              botName={draft.name}
              captureMode={captureMode}
              modelSelection={modelSelection}
              onComplete={onMessageSent}
            />
          ) : (
            <BotPromptComposer
              botName={draft.name || "your bot"}
              disabled
              readOnly
              onSubmit={async () => false}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function OnboardingSurface({
  initialDraft,
  environmentId,
  onFinished,
}: {
  readonly initialDraft: DesktopOnboardingDraft;
  readonly environmentId: EnvironmentId;
  readonly onFinished: () => void;
}) {
  const navigate = useNavigate();
  const reducedMotion = useReducedMotion();
  const createBot = useAtomCommand(botEnvironment.create, { reportFailure: false });
  const providers = useAtomValue(primaryServerProvidersAtom);
  const [draft, setDraft] = useState(initialDraft);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  const rosterBot = useRosterStore((state) =>
    draft.botId ? state.bots.find((bot) => bot.id === draft.botId) : undefined,
  );

  const updateDraft = (next: DesktopOnboardingDraft) => {
    setDraft(next);
    writeDraft(next);
  };

  const create = async () => {
    setCreating(true);
    setCreateError(null);
    const botId = BotId.make(`bot-${randomUUID()}`);
    const useCase = resolveDesktopOnboardingUseCase(draft.useCaseId, draft.customUseCase);
    const engine = resolveDesktopOnboardingEngine(draft.providerId, providers);
    if (!engine) {
      setCreating(false);
      setCreateError("The selected subscription is still loading. Try again.");
      return;
    }
    const result = await createBot({
      environmentId,
      input: {
        botId,
        name: draft.name.trim(),
        title: "Assistant",
        label: null,
        description: useCase.description,
        avatar: draft.avatar,
        engine,
        sandbox: null,
        runtimeMode: DEFAULT_BOT_RUNTIME_MODE,
        usageCap: null,
        groupId: null,
      },
    });
    setCreating(false);
    if (isAtomCommandInterrupted(result)) return;
    if (result._tag === "Failure") {
      setCreateError("Could not create your bot.");
      return;
    }
    writeBotDraft(`onboarding:${botId}`, useCase.prompt);
    updateDraft({ ...draft, step: "message", botId });
  };

  const finish = (firstMessage: string) => {
    setMessage(firstMessage);
    setFinishing(true);
    window.localStorage.removeItem(DESKTOP_ONBOARDING_STORAGE_KEY);
    window.localStorage.setItem(DESKTOP_ONBOARDING_COMPLETED_STORAGE_KEY, "1");
    const delay = reducedMotion ? 0 : 560;
    window.setTimeout(() => {
      if (draft.botId) {
        useRosterStore.getState().selectBot(draft.botId);
        void navigate({ to: "/bots/$botId", params: { botId: draft.botId }, replace: true });
      }
      onFinished();
    }, delay);
  };

  const step = stepNumber(draft.step);
  return (
    <motion.div
      data-testid="desktop-onboarding"
      className="fixed inset-0 z-[10000] flex overflow-hidden bg-background text-foreground"
      initial={reducedMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reducedMotion ? 0 : 0.18, ease: LEAVE }}
    >
      <motion.aside
        className="relative z-10 flex w-[38%] min-w-[390px] max-w-[540px] shrink-0 flex-col border-r border-border/70 bg-card/45 px-10 pb-10 pt-8 backdrop-blur-xl"
        animate={finishing ? { x: "-102%", opacity: 0 } : { x: 0, opacity: 1 }}
        transition={{ duration: reducedMotion ? 0 : 0.42, ease: finishing ? LEAVE : EASE }}
      >
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold tracking-[-0.015em]">Akeru Bot</span>
          <div className="flex items-center gap-1.5" aria-label={`Step ${step} of 4`}>
            {[1, 2, 3, 4].map((value) => (
              <span
                key={value}
                className={`h-1.5 rounded-full transition-all duration-300 motion-reduce:transition-none ${
                  value === step ? "w-6 bg-foreground" : "w-1.5 bg-foreground/20"
                }`}
              />
            ))}
          </div>
        </div>
        <div className="flex flex-1 items-center py-10">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={draft.step}
              className="w-full"
              initial={reducedMotion ? false : { opacity: 0, x: 18 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -12 }}
              transition={{ duration: reducedMotion ? 0 : 0.24, ease: EASE }}
            >
              {draft.step === "subscription" ? (
                <SubscriptionStep
                  environmentId={environmentId}
                  draft={draft}
                  onChange={updateDraft}
                  onContinue={() => updateDraft({ ...draft, step: "use-case" })}
                />
              ) : draft.step === "use-case" ? (
                <UseCaseStep
                  draft={draft}
                  onChange={updateDraft}
                  onBack={() => updateDraft({ ...draft, step: "subscription" })}
                  onContinue={() => updateDraft({ ...draft, step: "identity" })}
                />
              ) : draft.step === "identity" ? (
                <IdentityStep
                  draft={draft}
                  creating={creating}
                  error={createError}
                  onChange={updateDraft}
                  onBack={() => updateDraft({ ...draft, step: "use-case" })}
                  onContinue={() => void create()}
                />
              ) : (
                <div className="space-y-4">
                  <h1 className="text-balance text-[2rem] font-medium leading-[1.08] tracking-[-0.035em]">
                    Start with {draft.name}
                  </h1>
                  <p className="text-sm leading-6 text-muted-foreground">
                    Edit the suggested message, then send it. This becomes the real conversation.
                  </p>
                  {!rosterBot ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <LoaderIcon className="size-4 animate-spin motion-reduce:animate-none" />
                      Starting {draft.name}
                    </div>
                  ) : null}
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
        <p className="text-[11px] text-muted-foreground/65">Step {step} of 4</p>
      </motion.aside>
      <motion.div
        className="flex min-w-0 flex-1"
        animate={finishing ? { x: 0, scale: 1 } : { x: 0, scale: 1 }}
        transition={{ duration: reducedMotion ? 0 : 0.42, ease: EASE }}
      >
        <ConversationPreview
          draft={draft}
          message={message}
          createdBotReady={rosterBot !== undefined}
          modelSelection={desktopOnboardingModelSelection(rosterBot?.engine ?? null)}
          onMessageSent={finish}
        />
      </motion.div>
    </motion.div>
  );
}

export function DesktopOnboarding() {
  const environmentId = usePrimaryEnvironmentId();
  const atomKey = environmentId ?? NO_ENVIRONMENT;
  const rosterLoaded = useAtomValue(environmentRosterLoadedAtom(atomKey));
  const serverBots = useAtomValue(environmentBotsAtom(atomKey));
  const [draft] = useState(readDraft);
  const [completed] = useState(
    () => window.localStorage.getItem(DESKTOP_ONBOARDING_COMPLETED_STORAGE_KEY) === "1",
  );
  const [finished, setFinished] = useState(false);
  const initialDraftRef = useRef<DesktopOnboardingDraft | null>(draft);
  const captureMode = useCaptureMode();
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

  const show =
    !finished &&
    environmentId !== null &&
    initialDraftRef.current !== null &&
    (isElectron || captureMode);

  useEffect(() => {
    if (!rosterLoaded || serverBots.length === 0 || initialDraftRef.current !== null) return;
    window.localStorage.setItem(DESKTOP_ONBOARDING_COMPLETED_STORAGE_KEY, "1");
  }, [rosterLoaded, serverBots.length]);

  return (
    <AnimatePresence>
      {show && initialDraftRef.current && environmentId ? (
        <OnboardingSurface
          key="desktop-onboarding"
          initialDraft={initialDraftRef.current}
          environmentId={environmentId}
          onFinished={() => setFinished(true)}
        />
      ) : null}
    </AnimatePresence>
  );
}
