import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useMemo } from "react";

import { useI18n } from "../../i18n";
import { BotAvatarView } from "../roster/BotAvatarView";
import { OnboardingCelebration } from "./OnboardingCelebration";
import {
  desktopOnboardingHandoffAvatarState,
  desktopOnboardingHandoffStatus,
  desktopOnboardingHandoffStatuses,
  type DesktopOnboardingDraft,
  type DesktopOnboardingHandoffPhase,
} from "./desktopOnboarding.logic";

/** Slide-in for the sent bubble: --duration-fast on --ease-smooth-out. */
const LAUNCH_DURATION = 0.25;
const SMOOTH_OUT = [0.22, 1, 0.36, 1] as const;

/** Status swap: --think-swap, --think-gap, --think-distance, --think-blur. */
const SWAP_DURATION = 0.15;
const SWAP_GAP = 0.05;
const SWAP_DISTANCE = 8;
const SWAP_BLUR = "blur(2px)";

/**
 * The status line during the handoff. Lines swap with the thinking-state
 * motion (the outgoing copy floats up through a blur while the next one
 * rises from below) and shimmer briefly as they land, using the same treatment a
 * working bot gets everywhere else. The shimmer settles after two sweeps so a
 * slow remote wait does not repaint the whole time. A hidden sizer holds the
 * widest line so a swap never resizes the row, and a long bot name truncates.
 */
function HandoffStatus({
  phase,
  botName,
}: {
  readonly phase: DesktopOnboardingHandoffPhase;
  readonly botName: string;
}) {
  const reducedMotion = useReducedMotion();
  const { t } = useI18n();
  const status = desktopOnboardingHandoffStatus(phase, botName, t);
  const widest = useMemo(
    () =>
      desktopOnboardingHandoffStatuses(botName, t).reduce(
        (longest, candidate) => (candidate.length > longest.length ? candidate : longest),
        "",
      ),
    [botName, t],
  );

  return (
    <span
      role="status"
      aria-live="polite"
      data-testid="onboarding-handoff-status"
      className="relative block min-w-0 flex-1 text-sm font-medium"
    >
      <span aria-hidden className="invisible block truncate">
        {widest}
      </span>
      <AnimatePresence initial={false}>
        <motion.span
          key={status}
          className="bot-status-shimmer bot-status-shimmer-finite absolute inset-x-0 top-0 block truncate"
          initial={reducedMotion ? false : { opacity: 0, y: SWAP_DISTANCE, filter: SWAP_BLUR }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          exit={
            reducedMotion
              ? { opacity: 0, transition: { duration: 0 } }
              : {
                  opacity: 0,
                  y: -SWAP_DISTANCE,
                  filter: SWAP_BLUR,
                  transition: { duration: SWAP_DURATION, ease: "easeInOut" },
                }
          }
          transition={{
            duration: reducedMotion ? 0 : SWAP_DURATION,
            ease: "easeInOut",
            delay: reducedMotion ? 0 : SWAP_GAP,
          }}
        >
          {status}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/**
 * What the preview shows once the first message is away: the message landing
 * in the thread, the bot noticing it, and an honest line about what setup is
 * doing while the real workspace opens behind it.
 */
export function OnboardingHandoff({
  draft,
  message,
  phase,
  displayName,
}: {
  readonly draft: DesktopOnboardingDraft;
  readonly message: string;
  readonly phase: DesktopOnboardingHandoffPhase;
  readonly displayName: string;
}) {
  const reducedMotion = useReducedMotion();
  const avatarState = desktopOnboardingHandoffAvatarState(phase);

  return (
    <div className="w-full max-w-2xl space-y-8" data-testid="onboarding-handoff">
      <motion.div
        className="ml-auto max-w-[78%] rounded-2xl rounded-br-md bg-foreground px-4 py-3 text-sm text-background shadow-sm"
        initial={reducedMotion ? false : { opacity: 0, y: 16, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: reducedMotion ? 0 : LAUNCH_DURATION, ease: SMOOTH_OUT }}
      >
        {message}
      </motion.div>
      <motion.div
        className="relative flex items-center gap-3 text-muted-foreground"
        initial={reducedMotion ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{
          duration: reducedMotion ? 0 : LAUNCH_DURATION,
          ease: SMOOTH_OUT,
          delay: reducedMotion ? 0 : 0.12,
        }}
      >
        <OnboardingCelebration
          active={phase !== "sending"}
          seed={draft.botId ?? displayName}
          accent={draft.avatar.color}
        />
        <BotAvatarView
          avatar={draft.avatar}
          name={displayName}
          state={avatarState}
          className="relative z-20 size-7 shrink-0"
        />
        <HandoffStatus phase={phase} botName={displayName} />
      </motion.div>
    </div>
  );
}
