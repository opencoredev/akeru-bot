// @effect-diagnostics nodeBuiltinImport:off - Tests pin installer shell text and exercise its arg parsing.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
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

describe.runIf(
  Context.get(Context.empty(), HostProcessPlatform) === "linux" &&
    Context.get(Context.empty(), HostProcessArchitecture) === "x64",
)("install-linux.sh installation", () => {
  for (const scenario of [
    "fresh",
    "replacement",
    "checksum",
    "missing-entry",
    "download",
    "directory",
  ]) {
    it(`handles ${scenario} without leaving staging files`, () => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-install-test-"));
      try {
        const bin = NodePath.join(root, "bin");
        const home = NodePath.join(root, "home");
        const temp = NodePath.join(root, "tmp");
        const destination = NodePath.join(home, ".local/bin/akeru-bot");
        for (const directory of [bin, temp, NodePath.dirname(destination)]) {
          NodeFS.mkdirSync(directory, { recursive: true });
        }
        const payload = "fixture AppImage bytes\n";
        const asset = "Akeru-Bot-1.2.3-x64.AppImage";
        const digest = NodeCrypto.createHash("sha256").update(payload).digest("hex");
        NodeFS.writeFileSync(NodePath.join(root, "payload"), payload);
        NodeFS.writeFileSync(
          NodePath.join(root, "checksums"),
          `${scenario === "checksum" ? "0".repeat(64) : digest}  ${scenario === "missing-entry" ? "other.AppImage" : asset}\n`,
        );
        NodeFS.writeFileSync(
          NodePath.join(bin, "curl"),
          `#!/usr/bin/env bash
set -euo pipefail
out=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  https://github.com/opencoredev/akeru-bot/releases/download/v1.2.3/SHA256SUMS) cp "$FIXTURE_ROOT/checksums" "$out" ;;
  https://github.com/opencoredev/akeru-bot/releases/download/v1.2.3/Akeru-Bot-1.2.3-x64.AppImage)
    [ "$FIXTURE_SCENARIO" != download ] || exit 22
    cp "$FIXTURE_ROOT/payload" "$out" ;;
  *) exit 99 ;;
esac
`,
          { mode: 0o755 },
        );
        if (scenario === "directory") {
          NodeFS.mkdirSync(destination);
        } else if (scenario !== "fresh") {
          NodeFS.writeFileSync(destination, "previous installation");
        }
        const result = NodeChildProcess.spawnSync("bash", [scriptPath, "--tag", "v1.2.3"], {
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: home,
            TMPDIR: temp,
            PATH: `${bin}${NodePath.delimiter}${process.env.PATH}`,
            FIXTURE_ROOT: root,
            FIXTURE_SCENARIO: scenario,
          },
        });
        NodeAssert.ifError(result.error);
        if (scenario === "fresh" || scenario === "replacement") {
          NodeAssert.equal(result.status, 0, result.stderr);
          NodeAssert.equal(NodeFS.readFileSync(destination, "utf8"), payload);
          NodeAssert.ok(NodeFS.statSync(destination).mode & 0o111);
          NodeAssert.match(result.stdout, /Installed Akeru Bot v1.2.3\./);
        } else {
          NodeAssert.notEqual(result.status, 0);
          NodeAssert.doesNotMatch(result.stdout, /Installed Akeru Bot/);
          if (scenario === "directory") {
            NodeAssert.ok(NodeFS.statSync(destination).isDirectory());
          } else {
            NodeAssert.equal(NodeFS.readFileSync(destination, "utf8"), "previous installation");
          }
        }
        NodeAssert.deepEqual(NodeFS.readdirSync(NodePath.dirname(destination)), ["akeru-bot"]);
        NodeAssert.deepEqual(NodeFS.readdirSync(temp), []);
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

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
