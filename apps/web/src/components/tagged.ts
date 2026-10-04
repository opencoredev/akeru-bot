import { Predicate } from "effect";

/** Narrows both branches of a known union; Effect's predicate narrows only the match. */
export function isTagged<A, K extends string>(value: A, tag: K): value is Extract<A, { _tag: K }> {
  return Predicate.isTagged(value, tag);
}
