import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@akeru/client-runtime/state/runtime";
import { useI18n } from "../../i18n";
import { toastManager } from "../ui/toast";

export type Translate = ReturnType<typeof useI18n>["t"];

export function downloadArchive(filename: string, contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function reportFailure(
  title: string,
  result: AtomCommandResult<unknown, unknown>,
  t: Translate,
): void {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : t("The command failed."),
  });
}
