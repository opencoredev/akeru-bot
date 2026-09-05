// @effect-diagnostics nodeBuiltinImport:off - Tests pin installer shell text and exercise its arg parsing.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, it } from "vite-plus/test";

const scriptPath = NodePath.resolve(import.meta.dirname, "./install-macos.sh");
const script = NodeFS.readFileSync(scriptPath, "utf8");

function tryBash(args: string[]): { status: number; stdout: string; stderr: string } | null {
  try {
    const stdout = NodeChildProcess.execFileSync("bash", [scriptPath, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as {
      status?: number;
      stdout?: unknown;
      stderr?: unknown;
      code?: string;
    };
    if (failure.code === "ENOENT") return null;
    return {
      status: failure.status ?? 1,
      stdout: String(failure.stdout ?? ""),
      stderr: String(failure.stderr ?? ""),
    };
  }
}

describe("install-macos.sh", () => {
  it("starts in strict bash mode", () => {
    NodeAssert.ok(script.startsWith("#!/usr/bin/env bash\n"));
    NodeAssert.match(script, /^set -euo pipefail$/m);
    NodeAssert.doesNotMatch(script, /^set -x$/m);
  });

  it("gates on macOS Apple Silicon", () => {
    NodeAssert.match(script, /^\[ "\$\(uname -s\)" = Darwin \]$/m);
    NodeAssert.match(script, /^\[ "\$\(uname -m\)" = arm64 \]$/m);
  });

  it("uses a temp dir cleaned by an EXIT trap", () => {
    NodeAssert.match(script, /^tmp="\$\(mktemp -d\)"$/m);
    NodeAssert.match(
      script,
      /^trap 'hdiutil detach "\$mnt" >\/dev\/null 2>&1 \|\| true; rm -rf "\$tmp"' EXIT$/m,
    );
  });

  it("supports a --tag override and defaults to the latest stable release", () => {
    NodeAssert.match(script, /--tag\)/);
    NodeAssert.match(script, /--tag=\*\)/);
    NodeAssert.match(
      script,
      /curl -fsSL https:\/\/api\.github\.com\/repos\/opencoredev\/akeru-bot\/releases\/latest/,
    );
    NodeAssert.match(script, /if \[ -z "\$tag" \]; then/);
  });

  it("parses --tag, --tag=, --help, and rejects unknown args", () => {
    const help = tryBash(["--help"]);
    if (help === null) return;
    NodeAssert.equal(help.status, 0);
    NodeAssert.match(help.stdout, /usage: install-macos\.sh \[--tag vX\.Y\.Z\]/);

    const unknown = tryBash(["--bogus"]);
    NodeAssert.notEqual(unknown, null);
    NodeAssert.equal(unknown?.status, 1);
    NodeAssert.match(unknown?.stderr ?? "", /unknown argument/);
  });

  it("accepts only strict vX.Y.Z tags", () => {
    NodeAssert.match(script, /\[\[ "\$tag" =~ \^v\[0-9\]\+\[\.\]\[0-9\]\+\[\.\]\[0-9\]\+\$ \]\]/);
  });

  it("downloads the same-tag DMG and SHA256SUMS", () => {
    NodeAssert.match(script, /dmg="Akeru-Bot-\$\{version\}-arm64\.dmg"/);
    NodeAssert.match(
      script,
      /base="https:\/\/github\.com\/opencoredev\/akeru-bot\/releases\/download\/\$\{tag\}"/,
    );
    NodeAssert.match(script, /curl -fsSL -o "\$tmp\/SHA256SUMS" "\$base\/SHA256SUMS"/);
    NodeAssert.match(script, /curl -fL -o "\$tmp\/\$dmg" "\$base\/\$dmg"/);
    NodeAssert.doesNotMatch(script, /\/releases\/latest\/download/);
  });

  it("verifies the exact checksum line before mounting", () => {
    NodeAssert.match(
      script,
      /line="\$\(grep -E "\^\[a-fA-F0-9\]\{64\}\[\[:space:\]\]\+\\\*\?\$\{dmg\}\\\$" "\$tmp\/SHA256SUMS"\)" \|\| exit 1/,
    );
    NodeAssert.match(script, /printf "%s\\n" "\$line" \| shasum -a 256 -c -/);
    NodeAssert.match(
      script,
      /hdiutil attach "\$tmp\/\$dmg" -nobrowse -readonly -mountpoint "\$mnt"/,
    );
  });

  it("asserts the bundle identifier before installing", () => {
    NodeAssert.match(script, /Print :CFBundleIdentifier/);
    NodeAssert.match(script, /^\[ "\$identifier" = dev\.leodoes\.akeru \]$/m);
  });

  it("installs atomically with backup and rollback", () => {
    NodeAssert.match(
      script,
      /^osascript - "\$prepared_app" "\$new_app" "\$old_app" "\$app" <<'APPLESCRIPT'$/m,
    );
    NodeAssert.match(
      script,
      /new_app="\/Applications\/\.Akeru Bot \(Alpha\)\.app\.installing\.\$install_id"/,
    );
    NodeAssert.match(
      script,
      /old_app="\/Applications\/\.Akeru Bot \(Alpha\)\.app\.backup\.\$install_id"/,
    );
    NodeAssert.match(script, /mv " & installedApp & " " & oldApp/);
    NodeAssert.match(script, /mv " & newApp & " " & installedApp/);
    NodeAssert.match(script, /mv " & oldApp & " " & installedApp/);
    NodeAssert.match(script, /echo Previous application remains at " & oldApp & " >&2/);
    NodeAssert.match(script, /with administrator privileges/);
    NodeAssert.doesNotMatch(script, /backup\.\$\$/);
  });

  it("clears quarantine on the installed app only and never disables Gatekeeper", () => {
    NodeAssert.match(script, /^xattr -d com\.apple\.quarantine "\$app" 2>\/dev\/null \|\| true$/m);
    NodeAssert.doesNotMatch(script.toLowerCase(), /spctl/);
    NodeAssert.doesNotMatch(script.toLowerCase(), /disable/);
  });

  it("opens the app at the end", () => {
    NodeAssert.match(script, /^open "\$app"$/m);
    NodeAssert.ok(script.lastIndexOf('open "$app"') > script.lastIndexOf("APPLESCRIPT"));
  });

  it("keeps output to milestone lines only", () => {
    const echoes = script.split("\n").filter((line) => /^\s*echo /.test(line));
    NodeAssert.ok(echoes.length > 0 && echoes.length <= 8);
    for (const line of echoes) {
      NodeAssert.match(
        line,
        /usage:|unknown argument|--tag requires a value|Installing|Verifying checksum|Installed Akeru Bot/,
      );
    }
  });
});
