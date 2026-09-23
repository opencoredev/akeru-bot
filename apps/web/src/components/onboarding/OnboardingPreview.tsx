import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";

import { BotAvatarView } from "../roster/BotAvatarView";
import { BotPromptComposer } from "../roster/BotPromptComposer";
import { useBotThreadRuntime } from "../roster/useBotThreadRuntime";
import { SUBSCRIPTION_PROVIDERS } from "../settings/subscriptionProviders";
import { OnboardingHandoff } from "./OnboardingHandoff";
import {
  desktopOnboardingDestinationReady,
  desktopOnboardingHandoffAvatarState,
  resolveDesktopOnboardingFocusLabel,
  type DesktopOnboardingDraft,
  type DesktopOnboardingHandoffPhase,
  type desktopOnboardingModelSelection,
} from "./desktopOnboarding.logic";

const EASE = [0.23, 1, 0.32, 1] as const;

/** Caption under the assembling bot. Names what the user just did. */
function previewCaption(draft: DesktopOnboardingDraft): string {
  if (draft.step === "subscription") return "Pick the subscription that powers your bot";
  if (draft.step === "goal") return "Say what you want help with";
  if (draft.step === "identity") return "Give it a name and a look";
  return "Send the first message";
}

function ProviderChip({
  providerId,
}: {
  readonly providerId: DesktopOnboardingDraft["providerId"];
}) {
  const provider = SUBSCRIPTION_PROVIDERS.find((candidate) => candidate.id === providerId);
  if (!provider) return null;
  const ProviderIcon = typeof provider.icon === "string" ? null : provider.icon;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/70 py-1 pe-2.5 ps-2 text-xs text-muted-foreground">
      {ProviderIcon ? (
        <ProviderIcon className="size-3.5" />
      ) : (
        <img src={provider.icon as string} alt="" className="size-3.5 brightness-0 dark:invert" />
      )}
      {provider.label}
    </span>
  );
}

function FocusChip({ label }: { readonly label: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border/60 bg-background/70 px-2.5 py-1 text-xs text-muted-foreground">
      <span className="size-1.5 shrink-0 rounded-full bg-foreground/40" />
      <span className="truncate">{label}</span>
    </span>
  );
}

/**
 * The first message, and the eyes on where it lands. This is the same runtime
 * hook the chat route mounts, reading the same chat, messages and turn. Once
 * it sees the submitted message on a started turn, the workspace behind
 * setup is showing that conversation too and setup may fade off it.
 */
function FirstMessageComposer({
  botId,
  botName,
  captureMode,
  modelSelection,
  submittedMessage,
  onComplete,
  onDestinationReady,
}: {
  readonly botId: string;
  readonly botName: string;
  readonly captureMode: boolean;
  readonly modelSelection: ReturnType<typeof desktopOnboardingModelSelection>;
  /** The message that was sent, once it is away. Null until then. */
  readonly submittedMessage: string | null;
  readonly onComplete: (message: string) => void;
  readonly onDestinationReady: () => void;
}) {
  const runtime = useBotThreadRuntime(botId, modelSelection);
  const [error, setError] = useState<string | null>(null);
  const destinationReady =
    submittedMessage !== null &&
    desktopOnboardingDestinationReady({
      threadLinked: runtime.linkedThreadRef !== null,
      submittedMessage,
      messages: runtime.messages,
      turnStarted: runtime.latestTurn !== null,
    });

  useEffect(() => {
    if (destinationReady) onDestinationReady();
  }, [destinationReady, onDestinationReady]);

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

/**
 * The right half of setup: the teammate assembling in real time. Every choice
 * in the rail lands here within a frame, so the flow reads as shaping someone
 * rather than filling in a form.
 */
export function OnboardingPreview({
  draft,
  message,
  createdBotReady,
  captureMode,
  handoff,
  modelSelection,
  onMessageSent,
  onDestinationReady,
}: {
  readonly draft: DesktopOnboardingDraft;
  readonly message: string | null;
  readonly createdBotReady: boolean;
  readonly captureMode: boolean;
  /** Null until the first message is away, then the beat the handoff is on. */
  readonly handoff: DesktopOnboardingHandoffPhase | null;
  readonly modelSelection: ReturnType<typeof desktopOnboardingModelSelection>;
  readonly onMessageSent: (message: string) => void;
  /** Fired when the workspace behind setup is showing the sent conversation. */
  readonly onDestinationReady: () => void;
}) {
  const reducedMotion = useReducedMotion();
  const messageStep = draft.step === "message";
  const displayName = draft.name.trim() || "Your bot";
  const focusLabel =
    draft.step === "subscription" ? null : resolveDesktopOnboardingFocusLabel(draft.goal);
  const named = draft.name.trim().length > 0;
  const headerState = handoff ? desktopOnboardingHandoffAvatarState(handoff) : "idle";

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border/65 px-5">
        <BotAvatarView
          avatar={draft.avatar}
          name={displayName}
          state={headerState}
          className="size-7"
        />
        <span className="truncate text-sm font-medium">{displayName}</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 items-center justify-center px-4 lg:px-8">
          {message !== null && handoff !== null ? (
            <OnboardingHandoff
              draft={draft}
              message={message}
              phase={handoff}
              displayName={displayName}
            />
          ) : (
            <div className="relative hidden flex-col items-center text-center lg:flex">
              <motion.div
                layout
                transition={{ duration: reducedMotion ? 0 : 0.35, ease: EASE }}
                className="relative z-20 flex size-24 items-center justify-center rounded-[2rem] border border-border/55 bg-card/35 shadow-[0_24px_70px_-36px_rgba(0,0,0,0.45)]"
              >
                <BotAvatarView
                  avatar={draft.avatar}
                  name={displayName}
                  state="idle"
                  className="size-16"
                />
              </motion.div>
              <motion.h2
                layout
                className="mt-5 text-xl font-medium tracking-[-0.02em]"
                data-preview-named={named ? "true" : "false"}
              >
                {displayName}
              </motion.h2>
              <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5">
                <ProviderChip providerId={draft.providerId} />
                <AnimatePresence initial={false}>
                  {focusLabel ? (
                    // Keyed on presence, not text: the goal is typed a
                    // character at a time, and the chip must not re-animate
                    // on every keystroke.
                    <motion.span
                      key="focus"
                      className="inline-flex min-w-0"
                      initial={reducedMotion ? false : { opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={reducedMotion ? { opacity: 1 } : { opacity: 0, y: -4 }}
                      transition={{ duration: reducedMotion ? 0 : 0.18, ease: "easeOut" }}
                    >
                      <FocusChip label={focusLabel} />
                    </motion.span>
                  ) : null}
                </AnimatePresence>
              </div>
              <p className="mt-4 max-w-xs text-sm text-muted-foreground">{previewCaption(draft)}</p>
            </div>
          )}
        </div>
        <motion.div
          className="shrink-0"
          animate={handoff ? { opacity: 0, y: 8 } : { opacity: 1, y: 0 }}
          style={{ pointerEvents: handoff ? "none" : "auto" }}
          transition={{ duration: reducedMotion ? 0 : 0.25, ease: EASE }}
        >
          {messageStep && draft.botId && createdBotReady ? (
            <FirstMessageComposer
              botId={draft.botId}
              botName={draft.name}
              captureMode={captureMode}
              modelSelection={modelSelection}
              submittedMessage={message}
              onComplete={onMessageSent}
              onDestinationReady={onDestinationReady}
            />
          ) : (
            <BotPromptComposer
              botName={displayName}
              disabled
              readOnly
              onSubmit={async () => false}
            />
          )}
        </motion.div>
      </div>
    </div>
  );
}
