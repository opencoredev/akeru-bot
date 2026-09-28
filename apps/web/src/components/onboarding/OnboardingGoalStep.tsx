import { ArrowLeftIcon, ArrowRightIcon, PencilIcon } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import {
  DESKTOP_ONBOARDING_GOAL_MAX_LENGTH,
  type DesktopOnboardingDraft,
} from "./desktopOnboarding.logic";
import {
  DESKTOP_ONBOARDING_GOAL_EXAMPLES,
  DESKTOP_ONBOARDING_GOAL_QUESTION,
  DESKTOP_ONBOARDING_GOAL_THINKING_BEATS,
  desktopOnboardingGoalPlan,
  desktopOnboardingGoalThinkingMs,
  desktopOnboardingGoalThinkingStatus,
} from "./goalPlan.logic";

/** The step headline: the question while it asks, the plan once it has one. */
const GOAL_HEADING_ID = "onboarding-goal-heading";

const EASE = [0.23, 1, 0.32, 1] as const;
/** --think-swap and --think-distance, the same beat a working status uses. */
const SWAP_DURATION = 0.2;
const SWAP_DISTANCE = 10;
/** Plan steps arrive in the order they will happen, a beat apart. */
const STEP_STAGGER = 0.06;

/** Where the step is: asking, working out the plan, or showing it. */
type GoalPhase = "ask" | "thinking" | "plan";

function GoalExamples({ onPick }: { readonly onPick: (goal: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="onboarding-goal-examples">
      {DESKTOP_ONBOARDING_GOAL_EXAMPLES.map((example) => (
        <button
          key={example.topic}
          type="button"
          onClick={() => onPick(example.goal)}
          className="rounded-full border border-border/60 bg-background/70 px-3 py-1.5 text-xs text-muted-foreground outline-none transition-colors hover:border-border hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
        >
          {example.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The beat between the answer and the plan. It holds the answer that was just
 * given, so nothing blinks to empty, and says only what the app is doing:
 * reading the answer and deciding what to start on.
 */
function GoalThinking({ answer, status }: { readonly answer: string; readonly status: string }) {
  return (
    <div className="space-y-4" data-testid="onboarding-goal-thinking">
      <p className="text-xs font-medium text-muted-foreground">Your goal</p>
      <p className="border-s-2 border-border/70 ps-3 text-sm leading-6 text-muted-foreground">
        {answer}
      </p>
      <p
        role="status"
        aria-live="polite"
        className="bot-status-shimmer text-sm font-medium"
        data-testid="onboarding-goal-thinking-status"
      >
        {status}
      </p>
    </div>
  );
}

/**
 * The plan, in the bot's voice. It is a proposal rather than a question: the
 * user reads three concrete moves, sees the one detail that is being left for
 * later, and either agrees or goes back and says it differently. Nothing here
 * asks for a destination, a cadence, or an approval rule. Those come up when
 * the bot actually needs them.
 */
function GoalPlanView({
  goal,
  reducedMotion,
  onEdit,
}: {
  readonly goal: string;
  readonly reducedMotion: boolean;
  readonly onEdit: () => void;
}) {
  const plan = useMemo(() => desktopOnboardingGoalPlan(goal), [goal]);

  return (
    <div className="space-y-5" data-testid="onboarding-goal-plan">
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">Your goal</p>
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 border-s-2 border-border/70 ps-3 text-sm leading-6 text-muted-foreground">
            {goal}
          </p>
          <Button
            size="xs"
            variant="ghost-muted"
            className="shrink-0"
            data-testid="onboarding-goal-edit"
            onClick={onEdit}
          >
            <PencilIcon className="size-3.5" />
            Edit
          </Button>
        </div>
      </div>
      <div className="space-y-3">
        <h1
          id={GOAL_HEADING_ID}
          className="text-balance text-[1.75rem] font-medium leading-[1.1] tracking-[-0.035em] lg:text-[2rem] lg:leading-[1.08]"
        >
          I'll start by…
        </h1>
        <ol className="space-y-2.5" data-testid="onboarding-goal-plan-steps">
          {plan.steps.map((step, index) => (
            <motion.li
              key={step}
              className="flex items-baseline gap-3 text-sm leading-6"
              initial={reducedMotion ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                duration: reducedMotion ? 0 : SWAP_DURATION,
                ease: EASE,
                delay: reducedMotion ? 0 : index * STEP_STAGGER,
              }}
            >
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border/70 text-[11px] font-medium text-muted-foreground">
                {index + 1}
              </span>
              <span className="text-pretty">{step}</span>
            </motion.li>
          ))}
        </ol>
      </div>
      <p className="text-pretty border-t border-border/60 pt-4 text-xs leading-5 text-muted-foreground">
        {plan.deferred}
      </p>
    </div>
  );
}

/**
 * The goal step: one open question, then a plan the app works out from the
 * answer. It asks once and infers the rest: the destination, the cadence and
 * the approvals a bot eventually needs are left for the moment it needs them,
 * rather than collected up front from someone who has not seen it work yet.
 *
 * Everything is local, so the step never waits on the network and never stalls
 * a user who is offline. The plan is always correctable: editing goes back to
 * the answer, which is the only thing setup ever saved.
 */
export function OnboardingGoalStep({
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
  const reducedMotion = useReducedMotion() === true;
  const [goal, setGoal] = useState(draft.goal);
  const [phase, setPhase] = useState<GoalPhase>(draft.goalPhase);
  const [thinkingStatus, setThinkingStatus] = useState(
    () => DESKTOP_ONBOARDING_GOAL_THINKING_BEATS[0]?.status ?? "",
  );
  const draftRef = useRef(draft);
  const thinkingTimers = useRef<number[]>([]);

  draftRef.current = draft;

  const writeGoal = useCallback(
    (value: string) => {
      setGoal(value);
      onChange({ ...draftRef.current, goal: value, goalPhase: "ask" });
    },
    [onChange],
  );

  const clearThinking = useCallback(() => {
    for (const timer of thinkingTimers.current) window.clearTimeout(timer);
    thinkingTimers.current = [];
  }, []);

  useEffect(
    () => () => {
      for (const timer of thinkingTimers.current) window.clearTimeout(timer);
    },
    [],
  );

  /**
   * Answering hands over to the plan. The beat in between is the app reading
   * what was written. The pause is staged so the plan reads as considered
   * rather than instant, and is skipped entirely for anyone who asked not to
   * see motion.
   */
  const workOutPlan = useCallback(() => {
    onChange({ ...draftRef.current, goalPhase: "plan" });
    const hold = desktopOnboardingGoalThinkingMs(reducedMotion);
    if (hold === 0) {
      setPhase("plan");
      return;
    }
    clearThinking();
    setThinkingStatus(desktopOnboardingGoalThinkingStatus(0));
    setPhase("thinking");
    for (const beat of DESKTOP_ONBOARDING_GOAL_THINKING_BEATS) {
      if (beat.atMs === 0) continue;
      thinkingTimers.current.push(
        window.setTimeout(() => setThinkingStatus(beat.status), beat.atMs),
      );
    }
    thinkingTimers.current.push(
      window.setTimeout(() => {
        clearThinking();
        setPhase("plan");
      }, hold),
    );
  }, [clearThinking, onChange, reducedMotion]);

  const editGoal = useCallback(() => {
    clearThinking();
    onChange({ ...draftRef.current, goalPhase: "ask" });
    setPhase("ask");
  }, [clearThinking, onChange]);

  const goBack = useCallback(() => {
    if (phase === "plan") {
      editGoal();
      return;
    }
    onBack();
  }, [editGoal, onBack, phase]);

  const answered = goal.trim().length > 0;
  const thinking = phase === "thinking";

  return (
    <div className="space-y-6">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={phase}
          className="space-y-5"
          initial={reducedMotion ? false : { opacity: 0, y: SWAP_DISTANCE }}
          animate={{ opacity: 1, y: 0 }}
          exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -SWAP_DISTANCE }}
          transition={{ duration: reducedMotion ? 0 : SWAP_DURATION, ease: EASE }}
        >
          {phase === "thinking" ? (
            <GoalThinking answer={goal} status={thinkingStatus} />
          ) : phase === "plan" ? (
            <GoalPlanView goal={goal} reducedMotion={reducedMotion} onEdit={editGoal} />
          ) : (
            <>
              <div className="space-y-2">
                <h1
                  id={GOAL_HEADING_ID}
                  className="text-balance text-[1.75rem] font-medium leading-[1.1] tracking-[-0.035em] lg:text-[2rem] lg:leading-[1.08]"
                >
                  {DESKTOP_ONBOARDING_GOAL_QUESTION.prompt}
                </h1>
                <p className="text-pretty text-sm leading-6 text-muted-foreground">
                  {DESKTOP_ONBOARDING_GOAL_QUESTION.hint}
                </p>
              </div>
              <GoalExamples onPick={writeGoal} />
              <div className="space-y-2.5">
                <Textarea
                  autoFocus
                  size="lg"
                  rows={5}
                  className="min-h-32"
                  value={goal}
                  maxLength={DESKTOP_ONBOARDING_GOAL_MAX_LENGTH}
                  aria-labelledby={GOAL_HEADING_ID}
                  placeholder={DESKTOP_ONBOARDING_GOAL_QUESTION.placeholder}
                  onChange={(event) => writeGoal(event.currentTarget.value)}
                />
              </div>
            </>
          )}
        </motion.div>
      </AnimatePresence>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="icon"
          variant="ghost-muted"
          aria-label="Back"
          disabled={thinking}
          onClick={goBack}
        >
          <ArrowLeftIcon className="size-4" />
        </Button>
        <Button
          className="h-10 min-w-40 flex-1 rounded-xl"
          disabled={thinking || !answered}
          onClick={phase === "plan" ? onContinue : workOutPlan}
        >
          {phase === "plan" ? "Looks right" : "Continue"}
          <ArrowRightIcon className="size-4" />
        </Button>
      </div>
    </div>
  );
}
