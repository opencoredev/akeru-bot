import type { EnvironmentId, ServerProviderSkill } from "@akeru/contracts";
import { shouldOpenMarkdownFileLinkInBrowserByDefault } from "../../markdown-links";

export function canUseMarkdownFileShellActions(
  environmentId: EnvironmentId | null,
  shellAccess: { readonly isLocal: boolean; readonly isResolved: boolean },
): boolean {
  return environmentId !== null && shellAccess.isResolved && shellAccess.isLocal;
}

export function hasMarkdownFilePrimaryAction(input: {
  canOpenInEditor: boolean;
  canOpenInBrowser: boolean;
}): boolean {
  return input.canOpenInEditor || input.canOpenInBrowser;
}

export function shouldUseMarkdownFileBrowserPrimaryAction(input: {
  iconPath: string;
  canOpenInEditor: boolean;
  canOpenInBrowser: boolean;
}): boolean {
  return (
    input.canOpenInBrowser &&
    (shouldOpenMarkdownFileLinkInBrowserByDefault(input.iconPath) || !input.canOpenInEditor)
  );
}

export const EMPTY_MARKDOWN_SKILLS: ReadonlyArray<
  Pick<ServerProviderSkill, "name" | "displayName" | "icon">
> = [];
