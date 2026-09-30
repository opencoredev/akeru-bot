import * as Clipboard from "expo-clipboard";

/**
 * Copy a device sign-in code. Resolves false instead of rejecting when the
 * clipboard is unavailable, so the caller can ask the user to copy by hand.
 */
export async function copySignInCode(code: string): Promise<boolean> {
  try {
    await Clipboard.setStringAsync(code);
    return true;
  } catch {
    return false;
  }
}
