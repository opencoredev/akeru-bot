import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";
import {
  LINUX_CURL_INSTALL_COMMAND,
  LINUX_DOWNLOAD_DIALOG_BODY,
  LINUX_DOWNLOAD_DIALOG_TITLE,
  MAC_CURL_INSTALL_COMMAND,
  MAC_DOWNLOAD_DIALOG_BODY,
  MAC_DOWNLOAD_DIALOG_TITLE,
  WIN_DOWNLOAD_DIALOG_BODY,
  WIN_DOWNLOAD_DIALOG_TITLE,
  WIN_POWERSHELL_INSTALL_COMMAND,
  installPromptPlatformForDownload,
} from "./downloadInstallPrompt";

describe("installPromptPlatformForDownload", () => {
  it("shows the install prompt only after resolving a download", () => {
    expect(installPromptPlatformForDownload("mac", true)).toBe("mac");
    expect(installPromptPlatformForDownload("win", true)).toBe("win");
    expect(installPromptPlatformForDownload("linux", true)).toBe("linux");
    expect(installPromptPlatformForDownload("mac", false)).toBeNull();
    expect(installPromptPlatformForDownload("win", false)).toBeNull();
    expect(installPromptPlatformForDownload("linux", false)).toBeNull();
    expect(installPromptPlatformForDownload("ios", true)).toBeNull();
    expect(installPromptPlatformForDownload(undefined, true)).toBeNull();
  });

  it("sends macOS users to the release-pinned one-line installer", () => {
    expect(MAC_CURL_INSTALL_COMMAND).toBe(
      't=$(curl -fsSL https://api.github.com/repos/opencoredev/akeru-bot/releases/latest | sed -n \'s/.*"tag_name":[[:space:]]*"\\(v[0-9][^"]*\\)".*/\\1/p\' | head -1); if [ -z "$t" ]; then echo "Could not resolve the latest Akeru Bot release." >&2; (exit 1); else f=$(mktemp /tmp/akeru-install.XXXXXX) && curl -fsSL -o "$f" "https://raw.githubusercontent.com/opencoredev/akeru-bot/$t/scripts/install-macos.sh" && bash "$f" --tag "$t"; rc=$?; rm -f "${f:-/tmp/akeru-install-none}"; (exit $rc); fi',
    );
    expect(MAC_CURL_INSTALL_COMMAND).toContain("releases/latest");
    expect(MAC_CURL_INSTALL_COMMAND).toContain("/$t/scripts/install-macos.sh");
    expect(MAC_CURL_INSTALL_COMMAND).toContain('--tag "$t"');
    expect(MAC_CURL_INSTALL_COMMAND).toContain("f=$(mktemp /tmp/akeru-install.XXXXXX)");
    expect(MAC_CURL_INSTALL_COMMAND).toContain(
      'rc=$?; rm -f "${f:-/tmp/akeru-install-none}"; (exit $rc)',
    );
    expect(MAC_CURL_INSTALL_COMMAND).not.toContain("curl -fsSL -o /tmp/akeru-install.sh");
    expect(MAC_CURL_INSTALL_COMMAND).not.toContain("/releases/latest/download");
    expect(MAC_CURL_INSTALL_COMMAND).not.toContain("| bash");
    expect(MAC_DOWNLOAD_DIALOG_TITLE).toMatch(/one command/);
    expect(MAC_DOWNLOAD_DIALOG_BODY).toMatch(/one-liner/);
    expect(MAC_DOWNLOAD_DIALOG_BODY).toMatch(/latest stable release/);
    expect(MAC_DOWNLOAD_DIALOG_BODY).toMatch(/SHA256SUMS/);
  });

  it("sends Windows users to the release-pinned one-line installer", () => {
    expect(WIN_POWERSHELL_INSTALL_COMMAND).toBe(
      '$t = (Invoke-RestMethod https://api.github.com/repos/opencoredev/akeru-bot/releases/latest -ErrorAction Stop).tag_name; if ($t -match \'^v\\d+\\.\\d+\\.\\d+$\') { $f = Join-Path $env:TEMP $("akeru-install-$([Guid]::NewGuid()).ps1"); Invoke-WebRequest "https://raw.githubusercontent.com/opencoredev/akeru-bot/$t/scripts/install-windows.ps1" -OutFile $f -ErrorAction Stop; try { & $f -Tag $t } finally { Remove-Item $f } } else { throw "Could not resolve the latest Akeru Bot release." }',
    );
    expect(WIN_POWERSHELL_INSTALL_COMMAND).toContain("releases/latest");
    expect(WIN_POWERSHELL_INSTALL_COMMAND).toContain("/$t/scripts/install-windows.ps1");
    expect(WIN_POWERSHELL_INSTALL_COMMAND).toContain("-Tag $t");
    expect(WIN_POWERSHELL_INSTALL_COMMAND).toContain("Join-Path $env:TEMP");
    expect(WIN_POWERSHELL_INSTALL_COMMAND).toContain("[Guid]::NewGuid()");
    expect(WIN_POWERSHELL_INSTALL_COMMAND).toContain(
      "try { & $f -Tag $t } finally { Remove-Item $f }",
    );
    expect(WIN_POWERSHELL_INSTALL_COMMAND).not.toContain("New-TemporaryFile");
    expect(WIN_POWERSHELL_INSTALL_COMMAND).not.toContain("$env:TEMP\\akeru-install.ps1");
    expect(WIN_POWERSHELL_INSTALL_COMMAND).not.toContain("/releases/latest/download");
    expect(WIN_POWERSHELL_INSTALL_COMMAND).not.toContain("| bash");
    expect(WIN_POWERSHELL_INSTALL_COMMAND).not.toContain("/main/scripts/");
    expect(WIN_DOWNLOAD_DIALOG_TITLE).toMatch(/PowerShell/);
    expect(WIN_DOWNLOAD_DIALOG_BODY).toMatch(/one-liner/);
    expect(WIN_DOWNLOAD_DIALOG_BODY).toMatch(/latest stable release/);
    expect(WIN_DOWNLOAD_DIALOG_BODY).toMatch(/SHA256SUMS/);
  });

  it("sends Linux users to the release-pinned one-line installer", () => {
    expect(LINUX_CURL_INSTALL_COMMAND).toBe(
      't=$(curl -fsSL https://api.github.com/repos/opencoredev/akeru-bot/releases/latest | sed -n \'s/.*"tag_name":[[:space:]]*"\\(v[0-9][^"]*\\)".*/\\1/p\' | head -1); if [ -z "$t" ]; then echo "Could not resolve the latest Akeru Bot release." >&2; (exit 1); else f=$(mktemp /tmp/akeru-install.XXXXXX) && curl -fsSL -o "$f" "https://raw.githubusercontent.com/opencoredev/akeru-bot/$t/scripts/install-linux.sh" && bash "$f" --tag "$t"; rc=$?; rm -f "${f:-/tmp/akeru-install-none}"; (exit $rc); fi',
    );
    expect(LINUX_CURL_INSTALL_COMMAND).toContain("releases/latest");
    expect(LINUX_CURL_INSTALL_COMMAND).toContain("/$t/scripts/install-linux.sh");
    expect(LINUX_CURL_INSTALL_COMMAND).toContain('--tag "$t"');
    expect(LINUX_CURL_INSTALL_COMMAND).toContain("f=$(mktemp /tmp/akeru-install.XXXXXX)");
    expect(LINUX_CURL_INSTALL_COMMAND).toContain(
      'rc=$?; rm -f "${f:-/tmp/akeru-install-none}"; (exit $rc)',
    );
    expect(LINUX_CURL_INSTALL_COMMAND).not.toContain("curl -fsSL -o /tmp/akeru-install-linux.sh");
    expect(LINUX_CURL_INSTALL_COMMAND).not.toContain("/releases/latest/download");
    expect(LINUX_CURL_INSTALL_COMMAND).not.toContain("| bash");
    expect(LINUX_CURL_INSTALL_COMMAND).not.toContain("/main/scripts/");
    expect(LINUX_DOWNLOAD_DIALOG_TITLE).toMatch(/one command/);
    expect(LINUX_DOWNLOAD_DIALOG_BODY).toMatch(/one-liner/);
    expect(LINUX_DOWNLOAD_DIALOG_BODY).toMatch(/latest stable release/);
    expect(LINUX_DOWNLOAD_DIALOG_BODY).toMatch(/SHA256SUMS/);
  });

  it("keeps the install docs on the same fail-closed recipe", () => {
    const docs = NodeFS.readFileSync(
      NodePath.resolve(import.meta.dirname, "../../../../docs/user/install.md"),
      "utf8",
    );
    expect(docs).toContain(MAC_CURL_INSTALL_COMMAND);
    expect(docs).toContain(WIN_POWERSHELL_INSTALL_COMMAND);
    expect(docs).toContain(LINUX_CURL_INSTALL_COMMAND);
    expect(docs).not.toContain("MAC_GATEKEEPER_COMMAND");
  });
});
