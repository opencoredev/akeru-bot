// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const script = NodeFS.readFileSync(new URL("./install-remote.ps1", import.meta.url), "utf8");

describe("Windows remote installer", () => {
  it("verifies the GitHub release digest before extraction", () => {
    expect(script).toContain("Asset.digest");
    expect(script).toContain("Get-FileHash -Algorithm SHA256");
    expect(script.indexOf("Get-FileHash -Algorithm SHA256")).toBeLessThan(
      script.indexOf("Expand-Archive"),
    );
  });

  it("installs Tailscale unattended and starts Akeru through Task Scheduler", () => {
    expect(script).toContain("TS_UNATTENDEDMODE=always");
    expect(script).toContain("up --unattended=true");
    expect(script).not.toContain("service install");
    expect(script).toContain("Register-ScheduledTask -TaskName $TaskName");
    expect(script).toContain("Start-ScheduledTask -TaskName $TaskName");
    expect(script).toContain("New-ScheduledTaskTrigger -AtStartup");
    expect(script).toContain("-ExecutionTimeLimit ([TimeSpan]::Zero)");
    expect(script).toContain("service-launcher.mjs");
    expect(script).toContain('"versions\\$Version"');
    expect(script).toContain('".install-complete"');
    expect(script).toContain("protocol = 2; activeVersion = $Version");
    expect(script).toContain("`$env:AKERU_HOME = $(Quote-PowerShellLiteral $RuntimeHome)");
    expect(script).toContain("`$env:AKERU_INSTALL_ROOT = $(Quote-PowerShellLiteral $InstallRoot)");
    expect(script).toContain(
      '$TaskEnvironment + "& $(Quote-PowerShellLiteral $Launcher) remote update"',
    );
    expect(script).toContain('Register-ScheduledTask -TaskName "Akeru Remote Update"');
    expect(script).not.toContain("Heartbeat");
    expect(script).toContain("-LogonType S4U");
  });

  it("derives the server home from AKERU_HOME, never an ambient T3CODE_HOME", () => {
    expect(script).toContain(
      '$RuntimeHome = if ($env:AKERU_HOME) { $env:AKERU_HOME } else { Join-Path $HOME ".akeru" }',
    );
    expect(script).not.toContain("$env:T3CODE_HOME)");
    expect(script).not.toContain("$env:T3CODE_HOME }");
    expect(script).toContain("$env:T3CODE_HOME = $RuntimeHome");
  });

  it("only installs the Windows architecture the release publishes", () => {
    expect(script).toContain("not published for Windows arm64");
    expect(script).not.toContain("$LinkCode");
  });

  it("keeps the public installer endpoint identical", () => {
    expect(
      NodeFS.readFileSync(new URL("../apps/web/public/install.ps1", import.meta.url), "utf8"),
    ).toBe(script);
  });
});
