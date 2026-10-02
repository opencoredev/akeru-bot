import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";

function fixture() {
  const directory = NodePath.join(
    NodeOS.tmpdir(),
    `akeru-subscription-auth-${NodeCrypto.randomUUID()}`,
  );

  NodeFS.mkdirSync(directory, { recursive: true });
  const authPath = NodePath.join(directory, "subscription-auth.json");

  return { directory, authPath };
}

/** Resolves when the stubbed `fetch` is first called; credential reloads run before it. */
function requestSignal() {
  let markRequested!: () => void;

  const requested = new Promise<void>((resolve) => {
    markRequested = resolve;
  });

  return { requested, markRequested };
}

export { fixture, requestSignal };
