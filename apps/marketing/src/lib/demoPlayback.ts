export function pickMostVisibleDemo(ratios: readonly number[]): number | null {
  let active: number | null = null;

  for (const [index, ratio] of ratios.entries()) {
    if (ratio <= 0) continue;
    if (active === null || ratio > ratios[active]!) active = index;
  }

  return active;
}
