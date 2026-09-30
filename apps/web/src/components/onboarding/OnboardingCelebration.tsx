import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useMemo } from "react";

import { desktopOnboardingCelebrationPieces } from "./desktopOnboarding.logic";

/**
 * One-shot burst behind the avatar when setup finishes. Every piece animates
 * once and is removed, so nothing repaints after the burst settles; reduced
 * motion renders nothing at all rather than a still scatter of confetti.
 */
export function OnboardingCelebration({
  active,
  seed,
  accent,
}: {
  readonly active: boolean;
  readonly seed: string;
  readonly accent: string;
}) {
  const reducedMotion = useReducedMotion();
  const pieces = useMemo(() => desktopOnboardingCelebrationPieces(seed, accent), [seed, accent]);

  if (reducedMotion) return null;

  return (
    <AnimatePresence>
      {active ? (
        <div
          aria-hidden
          data-testid="onboarding-celebration"
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
        >
          {pieces.map((piece) => (
            <motion.span
              key={piece.id}
              className={`absolute size-1.5 ${piece.square ? "rounded-[2px]" : "rounded-full"}`}
              style={{ backgroundColor: piece.color }}
              initial={{ opacity: 0, x: 0, y: 0, scale: 0.4, rotate: 0 }}
              animate={{
                opacity: [0, 1, 1, 0],
                x: piece.x,
                y: [0, piece.y, piece.y + 26],
                scale: piece.scale,
                rotate: piece.rotate,
              }}
              exit={{ opacity: 0 }}
              transition={{
                duration: 0.78,
                delay: piece.delay * 0.66,
                ease: [0.16, 1, 0.3, 1],
                opacity: {
                  duration: 0.78,
                  times: [0, 0.12, 0.62, 1],
                  delay: piece.delay * 0.66,
                },
              }}
            />
          ))}
        </div>
      ) : null}
    </AnimatePresence>
  );
}
