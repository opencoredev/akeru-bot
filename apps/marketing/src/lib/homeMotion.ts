import { mountBotAvatar } from "./botAvatarRuntime";

// Runs `enter` each time an element scrolls into view and `leave` when it scrolls out,
// so nothing animates off screen.
function whileInView(
  selector: string,
  enter: (element: HTMLElement) => void,
  leave: (element: HTMLElement) => void,
) {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        const element = entry.target;

        if (!(element instanceof HTMLElement)) return;

        if (entry.isIntersecting) enter(element);
        else leave(element);
      });
    },
    { threshold: 0.6 },
  );

  document.querySelectorAll<HTMLElement>(selector).forEach((element) => observer.observe(element));
}

export function initToolToggles() {
  document.querySelectorAll<HTMLButtonElement>("button[data-toggle]").forEach((toggle) => {
    toggle.addEventListener("click", () => {
      toggle.setAttribute("aria-checked", String(toggle.getAttribute("aria-checked") !== "true"));
    });
  });
}

// "Create a bot": the name types in, the avatar pops into its slot with the onboarding
// confetti, then the provider chip lands. It resets off screen and replays on return.
const createTimers = new WeakMap<HTMLElement, number[]>();

function resetCreate(element: HTMLElement) {
  createTimers.get(element)?.forEach((timer) => window.clearTimeout(timer));
  createTimers.set(element, []);
  element.dataset.stage = "empty";
  const name = element.querySelector<HTMLElement>("[data-create-name]");

  if (name) name.textContent = "";
}

function playCreate(element: HTMLElement) {
  resetCreate(element);
  const timers = createTimers.get(element) ?? [];
  const name = element.querySelector<HTMLElement>("[data-create-name]");
  const full = element.dataset.name ?? "";
  const at = (ms: number, step: () => void) => timers.push(window.setTimeout(step, ms));

  at(320, () => (element.dataset.stage = "typing"));

  [...full].forEach((_, i) => {
    at(420 + i * 95, () => {
      if (name) name.textContent = full.slice(0, i + 1);
    });
  });

  const typed = 420 + full.length * 95 + 260;

  at(typed, () => {
    element.dataset.stage = "created";
    const avatar = element.querySelector<HTMLElement>(".bot-avatar");

    if (avatar) mountBotAvatar(avatar)?.beat(900);
  });

  at(typed + 420, () => (element.dataset.stage = "done"));
}

// "Hand it work": BotActivityStatus steps through the updates a working bot reports.
// The app remounts the label on each change, which restarts the sheen; this does too.
const activityTimers = new WeakMap<HTMLElement, number>();

function activityLabels(element: HTMLElement): string[] {
  return element.dataset.labels?.split("|") ?? [];
}

function setActivityLabel(element: HTMLElement, text: string) {
  const label = element.querySelector<HTMLElement>("[data-activity-label]");

  if (!label) return;
  label.replaceChildren(document.createTextNode(`${text}...`));
  const sheen = document.createElement("span");
  sheen.className = "bot-shimmer-sheen";
  sheen.setAttribute("aria-hidden", "true");
  const sheenText = document.createElement("span");
  sheenText.className = "bot-shimmer-sheen-text";
  sheenText.textContent = `${text}...`;
  sheen.append(sheenText);
  label.append(sheen);
}

function startActivity(element: HTMLElement) {
  element.dataset.active = "true";
  const labels = activityLabels(element);
  let index = 0;

  activityTimers.set(
    element,
    window.setInterval(() => {
      index = (index + 1) % labels.length;
      setActivityLabel(element, labels[index] ?? "");
    }, 2600),
  );
}

function stopActivity(element: HTMLElement) {
  delete element.dataset.active;
  window.clearInterval(activityTimers.get(element));
  setActivityLabel(element, activityLabels(element)[0] ?? "");
}

// Without a stage the create demo shows the finished bot, which is its static frame.
function settleCreate(element: HTMLElement) {
  resetCreate(element);
  delete element.dataset.stage;
  const name = element.querySelector<HTMLElement>("[data-create-name]");

  if (name) name.textContent = element.dataset.name ?? "";
}

// Both demos hold a static frame under reduced motion, including when the visitor
// turns it on while the page is open. They resume the next time they scroll into view.
export function initStepDemos() {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const creates = document.querySelectorAll<HTMLElement>("[data-create]");
  const activities = document.querySelectorAll<HTMLElement>("[data-activity]");

  const unlessReduced = (play: (element: HTMLElement) => void) => (element: HTMLElement) => {
    if (!reducedMotion.matches) play(element);
  };

  reducedMotion.addEventListener("change", () => {
    if (!reducedMotion.matches) return;
    creates.forEach(settleCreate);
    activities.forEach(stopActivity);
  });

  if (!reducedMotion.matches) creates.forEach(resetCreate);
  whileInView("[data-create]", unlessReduced(playCreate), unlessReduced(resetCreate));
  whileInView("[data-activity]", unlessReduced(startActivity), stopActivity);
}
