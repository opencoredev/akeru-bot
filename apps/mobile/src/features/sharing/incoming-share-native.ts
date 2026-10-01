import { Predicate } from "effect";
import type { SharePayload } from "expo-sharing";

const IOS_APP_GROUP_UNAVAILABLE_ERROR_CODE = "ERR_FAILED_TO_RESOLVE_APP_GROUP_ID";

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Expo native loading can throw arbitrary values; this probe reads only a string error code.
function errorCode(error: unknown): string | null {
  if (!Predicate.isObjectOrArray(error) || error === null || !("code" in error)) {
    return null;
  }

  return Predicate.isString(error.code) ? error.code : null;
}

/**
 * Normalizes the native "share into" capability to an empty inbox. Personal
 * Team builds cannot include the App Group that expo-sharing reads from.
 */
export function createIncomingSharePayloadReader(input: {
  readonly platform: string;
  readonly readPayloads: () => ReadonlyArray<SharePayload>;
}): () => ReadonlyArray<SharePayload> {
  let isUnavailable = false;

  return () => {
    if (isUnavailable) {
      return [];
    }

    try {
      return input.readPayloads();
    } catch (error) {
      if (input.platform === "ios" && errorCode(error) === IOS_APP_GROUP_UNAVAILABLE_ERROR_CODE) {
        isUnavailable = true;

        return [];
      }

      throw error;
    }
  };
}
