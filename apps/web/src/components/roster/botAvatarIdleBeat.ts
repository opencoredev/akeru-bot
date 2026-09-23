/**
 * Paces the rare idle beat. Resting avatars are static SVGs that cost
 * nothing per frame; every 20–40 seconds one avatar in the viewport wakes for
 * a moment so the roster still feels alive. At most one idle avatar animates
 * at a time, and nothing is scheduled while no avatar is mounted.
 */
const IDLE_BEAT_MIN_MS = 20_000;
const IDLE_BEAT_SPREAD_MS = 20_000;
export const IDLE_BEAT_LENGTH_MS = 1_600;

interface Sleeper {
  element: HTMLElement;
  wake: () => void;
}

const sleepers = new Set<Sleeper>();
let timer: ReturnType<typeof setTimeout> | null = null;

function isInViewport(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  return (
    rect.width > 0 &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth
  );
}

function schedule() {
  timer = setTimeout(beat, IDLE_BEAT_MIN_MS + Math.random() * IDLE_BEAT_SPREAD_MS);
}

function beat() {
  timer = null;
  if (sleepers.size === 0) return;
  if (!document.hidden) {
    const visible = [...sleepers].filter((sleeper) => isInViewport(sleeper.element));
    visible[Math.floor(Math.random() * visible.length)]?.wake();
  }
  schedule();
}

/** Registers a resting avatar as a candidate for the next idle beat. */
export function subscribeIdleBeat(element: HTMLElement, wake: () => void) {
  const sleeper = { element, wake };
  sleepers.add(sleeper);
  if (timer === null) schedule();
  return () => {
    sleepers.delete(sleeper);
    if (sleepers.size === 0 && timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
