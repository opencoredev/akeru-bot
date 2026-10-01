type FixtureReturn<Value> =
  Value extends Promise<infer Result> ? Promise<FixtureMember<Result>> : FixtureMember<Value>;

type FixtureMember<Value> = Value extends (...args: infer Args) => infer Result
  ? (...args: Args) => FixtureReturn<Result>
  : Value extends object
    ? { [Key in keyof Value]?: FixtureMember<Value[Key]> }
    : Value;

/** SDK fixtures supply the capabilities under test and reject accidental use of missing members. */
export function partialSdkFixture<Sdk extends object>(
  value: FixtureMember<Sdk>,
  absentMembers: readonly (keyof Sdk)[] = [],
): Sdk {
  const absent = new Set<PropertyKey>(absentMembers);

  // SAFETY: This test-only proxy supplies the declared SDK capabilities and throws if a test reaches an omitted member.
  return new Proxy(value, {
    get(target, key, receiver) {
      if (absent.has(key) || (key === "then" && !(key in target))) return undefined;

      if (!(key in target))
        throw new Error(`SDK fixture member '${String(key)}' was not supplied.`);

      // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy forwarding must preserve SDK fixture getters and their receiver, including symbol keys.
      return Reflect.get(target, key, receiver);
    },
  }) as Sdk;
}
