import { SandboxError } from "@opencoredev/sandbox-sdk";
import { quote } from "./BotWorkspaceLifecycle.ts";

/**
 * Sandbox SDK finds Railway and Upstash sandboxes through metadata it writes when it creates
 * them. Sandboxes made by Akeru's earlier adapters have none, and the SDK reports them as
 * not found. Adoption checks with the provider's own SDK that the sandbox still exists, then
 * writes the metadata the SDK expects, only where none is present.
 *
 * Resolves `false` only when the provider says the sandbox is gone.
 */
export type SandboxAdoption = (id: string, effects: AdoptionEffects) => Promise<boolean>;

/** What an adoption changed on the sandbox, so a failed reattach can put it back. */
export interface AdoptionEffects {
  /** Adoption resumed a paused sandbox to write its metadata. */
  resumed: boolean;
}

/** The record the SDK writes at creation: format version 1 and its ownership label. */
const METADATA = JSON.stringify({ version: 1, labels: { "sandbox-sdk": "1" } });

const RAILWAY_METADATA = "/tmp/.sandbox-sdk/railway.json";

const UPSTASH_METADATA = "/tmp/.sandbox-sdk/upstash.json";

const UPSTASH_METADATA_ENV = "SANDBOX_SDK_UPSTASH_METADATA";

/** Writes `file` with the SDK metadata unless something is already there. */
const writeIfAbsent = (file: string) =>
  `mkdir -p /tmp/.sandbox-sdk && { [ -e ${quote(file)} ] || printf %s ${quote(METADATA)} > ${quote(file)}; }`;

export function railwayAdoption(credentials: {
  readonly token: string;
  readonly environmentId: string;
}): SandboxAdoption {
  return async (id) => {
    const { Sandbox, SandboxNotFoundError } = await import("railway");
    let vm: Awaited<ReturnType<typeof Sandbox.connect>>;

    try {
      vm = await Sandbox.connect(id, credentials);
    } catch (cause) {
      if (cause instanceof SandboxNotFoundError) return false;
      throw cause;
    }

    if (vm.status === "DESTROYED" || vm.status === "DESTROYING") return false;
    const result = await vm.exec(writeIfAbsent(RAILWAY_METADATA));

    if (result.exitCode !== 0)
      throw new Error(`Could not record Sandbox SDK metadata on Railway VM '${id}'.`);

    return true;
  };
}

export function upstashAdoption(apiKey: string): SandboxAdoption {
  return async (id, effects) => {
    const { Box } = await import("@upstash/box");
    const listed = (await Box.list({ apiKey })).find((data) => data.id === id);

    if (!listed || listed.status === "deleted") return false;
    const box = await Box.get(id, { apiKey });

    // Commands need a running box; the session was about to wake it anyway.
    if (listed.status === "paused") {
      await box.resume();
      effects.resumed = true;
    }

    const result = await box.exec.command(
      `[ -n "$${UPSTASH_METADATA_ENV}" ] || ${writeIfAbsent(UPSTASH_METADATA)}`,
    );

    if (result.exitCode !== 0)
      throw new Error(`Could not record Sandbox SDK metadata on Upstash box '${id}'.`);

    return true;
  };
}

/**
 * Runs an SDK call that needs the sandbox's metadata. When it fails because the metadata is
 * missing, the sandbox is adopted and the call retried once; only the provider's own answer
 * that the sandbox is gone lets the original `not_found` through.
 */
export async function withAdoption<A>(
  adopt: SandboxAdoption | undefined,
  id: string,
  action: () => Promise<A>,
  effects: AdoptionEffects = { resumed: false },
): Promise<A> {
  try {
    return await action();
  } catch (cause) {
    if (
      !adopt ||
      !(cause instanceof SandboxError) ||
      (cause.code !== "not_found" && cause.code !== "file_not_found")
    )
      throw cause;

    if (!(await adopt(id, effects))) throw cause;

    try {
      return await action();
    } catch (retry) {
      // The provider says the sandbox exists, so a second "not found" is about its metadata.
      if (retry instanceof SandboxError && retry.code === "not_found")
        throw new SandboxError(
          `Sandbox '${id}' exists but its Sandbox SDK metadata is unreadable. Check the sandbox before retrying.`,
          { code: "unavailable", provider: retry.provider, sandboxId: id },
        );
      throw retry;
    }
  }
}
