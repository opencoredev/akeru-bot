import * as Predicate from "effect/Predicate";

/** Preserve union members when checking a tag, including in the opposite branch. */
export function hasTag<Value extends { readonly _tag: string }, Tag extends Value["_tag"]>(
  value: Value,
  tag: Tag,
): value is Extract<Value, { readonly _tag: Tag }> {
  return Predicate.isTagged(value, tag);
}
