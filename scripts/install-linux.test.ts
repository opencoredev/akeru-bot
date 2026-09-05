// @effect-diagnostics nodeBuiltinImport:off - Tests pin installer shell text and exercise its arg parsing.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, it } from "vite-plus/test";

const scriptPath = NodePath.resolve(import.meta.dirname, "./install-linux.sh");
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

describe("install-linux.sh", () => {
  it("starts in strict bash mode", () => {
    NodeAssert.ok(script.startsWith("#!/usr/bin/env bash\n"));
    NodeAssert.match(script, /^set -euo pipefail$/m);
    NodeAssert.doesNotMatch(script, /^set -x$/m);
  });

  it("gates on Linux x86_64", () => {
    NodeAssert.match(script, /^\[ "\$\(uname -s\)" = Linux \]$/m);
    NodeAssert.match(script, /^\s*x86_64\|amd64\) ;;$/m);
  });

  it("uses a temp dir cleaned by an EXIT trap", () => {
    NodeAssert.match(script, /^tmp="\$\(mktemp -d\)"$/m);
    NodeAssert.match(script, /^trap 'rm -rf "\$tmp"' EXIT$/m);
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
    NodeAssert.match(help.stdout, /usage: install-linux\.sh \[--tag vX\.Y\.Z\]/);
    NodeAssert.match(help.stdout, /Akeru-Bot-.*-x64\.AppImage/);

    const unknown = tryBash(["--bogus"]);
    NodeAssert.notEqual(unknown, null);
    NodeAssert.equal(unknown?.status, 1);
    NodeAssert.match(unknown?.stderr ?? "", /unknown argument/);

    const missing = tryBash(["--tag"]);
    NodeAssert.notEqual(missing, null);
    NodeAssert.equal(missing?.status, 1);
    NodeAssert.match(missing?.stderr ?? "", /--tag requires a value/);
  });

  it("accepts only strict vX.Y.Z tags", () => {
    NodeAssert.match(script, /\[\[ "\$tag" =~ \^v\[0-9\]\+\[\.\]\[0-9\]\+\[\.\]\[0-9\]\+\$ \]\]/);
  });

  it("downloads the same-tag AppImage and SHA256SUMS", () => {
    NodeAssert.match(script, /appimage="Akeru-Bot-\$\{version\}-x64\.AppImage"/);
    NodeAssert.match(
      script,
      /base="https:\/\/github\.com\/opencoredev\/akeru-bot\/releases\/download\/\$\{tag\}"/,
    );
    NodeAssert.match(script, /curl -fsSL -o "\$tmp\/SHA256SUMS" "\$base\/SHA256SUMS"/);
    NodeAssert.match(script, /curl -fL -o "\$tmp\/\$appimage" "\$base\/\$appimage"/);
    NodeAssert.doesNotMatch(script, /\/releases\/latest\/download/);
  });

  it("verifies the exact checksum line before installing", () => {
    NodeAssert.match(
      script,
      /line="\$\(grep -E "\^\[a-fA-F0-9\]\{64\}\[\[:space:\]\]\+\\\*\?\$\{appimage\}\\\$" "\$tmp\/SHA256SUMS"\)" \|\| exit 1/,
    );
    NodeAssert.match(script, /sha256sum -c -/);
    NodeAssert.doesNotMatch(script, /shasum/);
  });

  it("installs atomically to ~/.local/bin with a per-run staging path", () => {
    NodeAssert.match(script, /dest="\$HOME\/\.local\/bin\/akeru-bot"/);
    NodeAssert.match(script, /mkdir -p "\$HOME\/\.local\/bin"/);
    NodeAssert.match(script, /if \[ -e "\$dest" \] && \[ ! -f "\$dest" \]; then/);
    NodeAssert.match(script, /refusing to overwrite non-regular file/);
    NodeAssert.match(script, /staged="\$dest\.new\.\$\$"/);
    NodeAssert.match(script, /trap 'rm -rf "\$tmp"; rm -f "\$staged"' EXIT/);
    NodeAssert.match(script, /cp -p "\$tmp\/\$appimage" "\$staged"/);
    NodeAssert.match(script, /chmod \+x "\$staged"/);
    NodeAssert.match(script, /mv -f "\$staged" "\$dest"/);
    NodeAssert.doesNotMatch(script, /cp -p "\$tmp\/\$appimage" "\$dest"/);
    NodeAssert.doesNotMatch(script, /staged="\$dest\.new"/);
    NodeAssert.doesNotMatch(script, /\.backup/);
  });

  it("prints the exact success sentence last", () => {
    NodeAssert.match(script, /^echo "Installed Akeru Bot \$tag\."$/m);
    const lines = script.split("\n");
    const installed = lines.filter((line) => line === 'echo "Installed Akeru Bot $tag."');
    NodeAssert.equal(installed.length, 1);
    NodeAssert.ok(script.trimEnd().endsWith('echo "Installed Akeru Bot $tag."'));
  });

  it("documents a private-temp-file one-liner that preserves failures", () => {
    NodeAssert.match(script, /if \[ -z "\$t" \]; then/);
    NodeAssert.match(
      script,
      /raw\.githubusercontent\.com\/opencoredev\/akeru-bot\/\$t\/scripts\/install-linux\.sh/,
    );
    NodeAssert.match(script, /--tag "\$t"/);
    NodeAssert.match(script, /f=\$\(mktemp \/tmp\/akeru-install\.XXXXXX\)/);
    NodeAssert.match(script, /Could not resolve the latest Akeru Bot release/);
    NodeAssert.match(script, /rc=\$\?; rm -f "\$\{f:-\/tmp\/akeru-install-none\}"; \(exit \$rc\)/);
    NodeAssert.doesNotMatch(script, /curl -fsSL -o \/tmp\/akeru-install-linux\.sh/);
    NodeAssert.doesNotMatch(script, /\|\s*(bash|sh)([\s;]|$)/);
  });

  it("keeps output to milestone lines only", () => {
    const echoes = script.split("\n").filter((line) => /^\s*echo /.test(line));
    NodeAssert.ok(echoes.length > 0 && echoes.length <= 12);
    for (const line of echoes) {
      NodeAssert.match(
        line,
        /usage:|unknown argument|--tag requires a value|unsupported architecture|refusing to overwrite|Installing|Verifying checksum|Installed Akeru Bot|installs Akeru-Bot-/,
      );
    }
  });
});
