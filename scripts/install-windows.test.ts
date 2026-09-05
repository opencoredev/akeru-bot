// @effect-diagnostics nodeBuiltinImport:off - Tests pin installer script text; PowerShell cannot run here.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, it } from "vite-plus/test";

const scriptPath = NodePath.resolve(import.meta.dirname, "./install-windows.ps1");
const script = NodeFS.readFileSync(scriptPath, "utf8");

describe("install-windows.ps1", () => {
  it("stops on every failed check", () => {
    NodeAssert.match(script, /^\$ErrorActionPreference = 'Stop'$/m);
  });

  it("gates on Windows x64 and refuses ARM64 and x86", () => {
    NodeAssert.match(script, /\$env:PROCESSOR_ARCHITECTURE/);
    NodeAssert.match(script, /\$env:PROCESSOR_ARCHITECTURE -ne 'AMD64'/);
    NodeAssert.match(script, /ARM64/);
    NodeAssert.match(script, /x86/);
  });

  it("requires TLS 1.2", () => {
    NodeAssert.match(script, /\[Net\.ServicePointManager\]::SecurityProtocol/);
    NodeAssert.match(script, /Tls12/);
  });

  it("supports a -Tag override and defaults to the latest stable release", () => {
    NodeAssert.match(script, /\$Tag/);
    NodeAssert.match(script, /Invoke-RestMethod/);
    NodeAssert.match(
      script,
      /https:\/\/api\.github\.com\/repos\/opencoredev\/akeru-bot\/releases\/latest/,
    );
    NodeAssert.match(script, /if \(-not \$Tag\)/);
  });

  it("accepts only strict vX.Y.Z tags", () => {
    NodeAssert.match(script, /\^v\\d\+\\.\\d\+\\.\\d\+\$/);
  });

  it("downloads the same-tag exe and SHA256SUMS to TEMP", () => {
    NodeAssert.match(script, /Akeru-Bot-\$version-x64\.exe/);
    NodeAssert.match(
      script,
      /\$base = "https:\/\/github\.com\/opencoredev\/akeru-bot\/releases\/download\/\$Tag"/,
    );
    NodeAssert.match(script, /Join-Path \$env:TEMP/);
    NodeAssert.match(script, /Invoke-WebRequest -Uri "\$base\/\$asset" -OutFile \$installerPath/);
    NodeAssert.match(script, /Invoke-WebRequest -Uri "\$base\/SHA256SUMS" -OutFile \$checksumPath/);
    NodeAssert.doesNotMatch(script, /\/releases\/latest\/download/);
  });

  it("verifies the exact checksum line with Get-FileHash before unblocking", () => {
    NodeAssert.match(script, /Select-String -Path \$checksumPath/);
    NodeAssert.match(script, /\[regex\]::Escape\(\$asset\)/);
    NodeAssert.match(script, /if \(\$entries\.Count -ne 1\)/);
    NodeAssert.match(script, /Get-FileHash -Path \$installerPath -Algorithm SHA256/);
    const hashIndex = script.indexOf("Get-FileHash");
    NodeAssert.ok(hashIndex > -1);
    NodeAssert.ok(script.indexOf("Unblock-File") > hashIndex);
  });

  it("unblocks the installer, checks its exit code, and runs it without silent flags", () => {
    NodeAssert.match(script, /^Unblock-File -Path \$installerPath$/m);
    NodeAssert.match(script, /\$proc = Start-Process -FilePath \$installerPath -Wait -PassThru/);
    NodeAssert.match(script, /if \(\$proc\.ExitCode -ne 0\)/);
    NodeAssert.match(script, /installer exited with code/);
    NodeAssert.ok(script.indexOf("Start-Process") > script.indexOf("Unblock-File"));
    NodeAssert.doesNotMatch(script, /\/verysilent/i);
    NodeAssert.doesNotMatch(script, /\/silent/i);
    NodeAssert.doesNotMatch(script, /\/quiet/i);
    NodeAssert.doesNotMatch(script, / --silent/i);
    NodeAssert.doesNotMatch(script, / --quiet/i);
  });

  it("never changes system-wide security settings", () => {
    NodeAssert.doesNotMatch(script, /Disable-/);
    NodeAssert.doesNotMatch(script, /Set-ExecutionPolicy/);
    NodeAssert.doesNotMatch(script, /SmartScreen/i);
  });

  it("supports -Help", () => {
    NodeAssert.match(script, /\[switch\]\$Help/);
    NodeAssert.match(script, /if \(\$Help\)/);
    NodeAssert.match(script, /usage: install-windows\.ps1 \[-Tag vX\.Y\.Z\]/);
  });

  it("prints the exact success sentence", () => {
    NodeAssert.match(script, /Write-Output "Installed Akeru Bot \$Tag\."/);
  });
});
