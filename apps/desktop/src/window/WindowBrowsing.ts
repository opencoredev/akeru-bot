import type * as Electron from "electron";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ElectronShell from "../electron/ElectronShell.ts";
import type * as ElectronMenu from "../electron/ElectronMenu.ts";
import { isSameOriginRendererNavigation } from "./WindowPresentation.ts";

export function bindWindowBrowsing({
  window,
  applicationUrl,
  electronShell,
  electronMenu,
  runPromise,
}: {
  window: Electron.BrowserWindow;
  applicationUrl: string;
  electronShell: ElectronShell.ElectronShell["Service"];
  electronMenu: ElectronMenu.ElectronMenu["Service"];
  runPromise: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
}) {
  const contextMenuContents = new WeakSet<Electron.WebContents>();

  const installContextMenu = (
    ownerWindow: Electron.BrowserWindow,
    contents: Electron.WebContents,
  ): void => {
    if (contextMenuContents.has(contents)) return;
    contextMenuContents.add(contents);
    contents.on("context-menu", (event, params) => {
      event.preventDefault();

      if (contents.isDestroyed() || ownerWindow.isDestroyed()) return;
      // Native editing roles act on the focused contents, which may still be
      // the host renderer when the user right-clicks inside a browser guest.
      contents.focus();

      const menuTemplate: Electron.MenuItemConstructorOptions[] = [];

      if (params.misspelledWord) {
        for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
          menuTemplate.push({
            label: suggestion,
            click: () => {
              if (!contents.isDestroyed()) contents.replaceMisspelling(suggestion);
            },
          });
        }

        if (params.dictionarySuggestions.length === 0) {
          menuTemplate.push({ label: "No suggestions", enabled: false });
        }

        menuTemplate.push({ type: "separator" });
      }

      if (Option.isSome(ElectronShell.parseSafeExternalUrl(params.linkURL))) {
        menuTemplate.push(
          {
            label: "Copy Link",
            click: () => {
              void runPromise(electronShell.copyText(params.linkURL));
            },
          },
          { type: "separator" },
        );
      }

      if (params.mediaType === "image") {
        menuTemplate.push({
          label: "Copy Image",
          click: () => {
            if (!contents.isDestroyed()) contents.copyImageAt(params.x, params.y);
          },
        });
        menuTemplate.push({ type: "separator" });
      }

      menuTemplate.push(
        { role: "cut", enabled: params.editFlags.canCut },
        { role: "copy", enabled: params.editFlags.canCopy },
        { role: "paste", enabled: params.editFlags.canPaste },
        { role: "selectAll", enabled: params.editFlags.canSelectAll },
      );

      void runPromise(
        electronMenu.popupTemplate({
          window: ownerWindow,
          template: menuTemplate,
          ...(params.frame ? { frame: params.frame } : {}),
        }),
      );
    });
    contents.on("did-create-window", (popup) => {
      installContextMenu(popup, popup.webContents);
    });
  };

  installContextMenu(window, window.webContents);
  window.webContents.on("did-attach-webview", (_event, contents) => {
    installContextMenu(window, contents);
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (Option.isSome(ElectronShell.parseSafeExternalUrl(url))) {
      void runPromise(electronShell.openExternal(url));
    }

    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (
      isSameOriginRendererNavigation({
        applicationUrl,
        navigationUrl: url,
      })
    ) {
      return;
    }

    event.preventDefault();

    if (Option.isSome(ElectronShell.parseSafeExternalUrl(url))) {
      void runPromise(electronShell.openExternal(url));
    }
  });
}
