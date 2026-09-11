import { REMOTE_CAPABLE_EDITOR_IDS, remoteSchemeForEditor } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Electron from "electron";

// Remote open-in-editor deep links (`vscode://vscode-remote/ssh-remote+…`,
// `zed://ssh/<host>/<path>`) must reach the OS handler; every other non-web
// scheme stays blocked.
const SAFE_WEB_PROTOCOLS = new Set(["http:", "https:"]);
const REMOTE_EDITOR_PROTOCOLS = new Set(
  REMOTE_CAPABLE_EDITOR_IDS.flatMap((id) => {
    const scheme = remoteSchemeForEditor(id);
    return scheme === undefined ? [] : [`${scheme}:`];
  }),
);

// Zed's host sits in the first path segment, so it needs its own userinfo ban.
const ZED_SSH_HOST = /^[^/@:]+$/;

function isZedSshUrl(url: URL): boolean {
  if (url.host !== "ssh") {
    return false;
  }
  const encodedHost = url.pathname.split("/")[1];
  if (!encodedHost) {
    return false;
  }
  let host: string;
  try {
    host = decodeURIComponent(encodedHost);
  } catch {
    return false;
  }
  return ZED_SSH_HOST.test(host) && url.pathname.length > encodedHost.length + 1;
}

const isRemoteEditorUrl = (url: URL) =>
  REMOTE_EDITOR_PROTOCOLS.has(url.protocol) &&
  url.username.length === 0 &&
  url.password.length === 0 &&
  (url.protocol === "zed:"
    ? isZedSshUrl(url)
    : url.host === "vscode-remote" &&
      url.pathname.startsWith("/ssh-remote+") &&
      url.pathname.length > "/ssh-remote+".length);

export function parseSafeExternalUrl(rawUrl: unknown): Option.Option<string> {
  if (typeof rawUrl !== "string") {
    return Option.none();
  }

  try {
    const url = new URL(rawUrl);
    return SAFE_WEB_PROTOCOLS.has(url.protocol) || isRemoteEditorUrl(url)
      ? Option.some(url.href)
      : Option.none();
  } catch {
    return Option.none();
  }
}

export class ElectronShell extends Context.Service<
  ElectronShell,
  {
    readonly openExternal: (rawUrl: unknown) => Effect.Effect<boolean>;
    readonly copyText: (text: string) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/electron/ElectronShell") {}

export const make = ElectronShell.of({
  openExternal: (rawUrl) =>
    Option.match(parseSafeExternalUrl(rawUrl), {
      onNone: () => Effect.succeed(false),
      onSome: (externalUrl) =>
        Effect.promise(() =>
          Electron.shell.openExternal(externalUrl).then(
            () => true,
            () => false,
          ),
        ),
    }),
  copyText: (text) =>
    Effect.sync(() => {
      Electron.clipboard.writeText(text);
    }),
});

export const layer = Layer.succeed(ElectronShell, make);
