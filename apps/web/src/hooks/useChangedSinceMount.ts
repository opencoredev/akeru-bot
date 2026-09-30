import { useState } from "react";

/**
 * True once `value` has differed from its first render. Entrance animations use
 * it to play on user navigation but stay still on the initial mount.
 */
export function useChangedSinceMount<T>(value: T): boolean {
  const [initial] = useState(value);
  const [changed, setChanged] = useState(false);
  if (!changed && !Object.is(value, initial)) setChanged(true);
  return changed || !Object.is(value, initial);
}
