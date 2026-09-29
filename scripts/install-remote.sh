#!/bin/sh
set -eu
repo="${AKERU_REMOTE_REPOSITORY:-opencoredev/akeru-bot}"
[ "$repo" = opencoredev/akeru-bot ] || [ "${AKERU_REMOTE_ALLOW_CUSTOM_REPOSITORY:-0}" = 1 ] || { printf 'Custom release repositories require AKERU_REMOTE_ALLOW_CUSTOM_REPOSITORY=1 and artifacts signed by the pinned Akeru release key.\n' >&2; exit 1; }
install_root="${AKERU_INSTALL_ROOT:-$HOME/.local/share/akeru}"
bin_dir="${AKERU_BIN_DIR:-$HOME/.local/bin}"
tag="${AKERU_VERSION:-}"
# Akeru state always lives in AKERU_HOME or ~/.akeru. The bundled server reads T3CODE_HOME, so it is
# derived here and never taken from an ambient T3 Code environment.
runtime_home="${AKERU_HOME:-$HOME/.akeru}"
AKERU_HOME="$runtime_home"
T3CODE_HOME="$runtime_home"
export AKERU_HOME T3CODE_HOME
use_tailscale=1
install_updates=1
prepare_only=0
migrate_environment_id=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --tag) tag="$2"; shift 2 ;;
    --no-tailscale) use_tailscale=0; shift ;;
    --no-auto-update) install_updates=0; shift ;;
    --prepare-only) prepare_only=1; install_updates=0; shift ;;
    --migrate-environment-id) migrate_environment_id=1; shift ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done
for command_name in curl tar openssl; do
  command -v "$command_name" >/dev/null 2>&1 || { printf '%s is required.\n' "$command_name" >&2; exit 1; }
done
# Quotes one value for a systemd unit line; %% keeps systemd specifiers literal.
systemd_quote() {
  printf '"%s"' "$(printf '%s' "$1" | sed -e 's/%/%%/g' -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
}
verify_checksum() {
  expected="$1"; file="$2"
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$file" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  else
    printf 'sha256sum or shasum is required.\n' >&2; exit 1
  fi
  [ "$actual" = "$expected" ] || { printf 'SHA-256 verification failed for %s.\n' "$(basename "$file")" >&2; exit 1; }
}
if [ -z "$tag" ]; then
  tag="$(curl --proto '=https' --tlsv1.2 -fsSL "https://api.github.com/repos/$repo/releases/latest" | sed -n 's/.*"tag_name":[[:space:]]*"\(v[0-9][^"]*\)".*/\1/p' | head -1)"
fi
[ -n "$tag" ] || { printf 'Could not resolve the latest Akeru release.\n' >&2; exit 1; }
version="${tag#v}"
case "$(uname -s)" in
  Linux) platform=linux ;;
  Darwin) platform=darwin ;;
  *) printf 'The Unix installer supports Linux and macOS. On Windows, use the PowerShell installer.\n' >&2; exit 1 ;;
esac
case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) printf 'Unsupported CPU: %s\n' "$(uname -m)" >&2; exit 1 ;; esac
# Releases publish Akeru Remote for Linux x64 and macOS arm64 only.
case "$platform-$arch" in
  linux-x64|darwin-arm64) ;;
  *) printf 'Akeru Remote releases are not published for %s %s yet. Use Docker or build from source.\n' "$platform" "$arch" >&2; exit 1 ;;
esac
archive="Akeru-Remote-$version-$platform-$arch.tar.gz"
base="https://github.com/$repo/releases/download/$tag"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/akeru-install.XXXXXX")"
trap 'rm -rf "$tmp" "${next:-}"' EXIT HUP INT TERM
curl --proto '=https' --tlsv1.2 -fsSL -o "$tmp/$archive" "$base/$archive"
curl --proto '=https' --tlsv1.2 -fsSL -o "$tmp/AKERU-REMOTE-MANIFEST.txt" "$base/AKERU-REMOTE-MANIFEST.txt"
curl --proto '=https' --tlsv1.2 -fsSL -o "$tmp/AKERU-REMOTE-MANIFEST.sig" "$base/AKERU-REMOTE-MANIFEST.sig"
cat > "$tmp/akeru-release-manifest.pub" <<'KEY'
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAr6AVDZl+P/T3TxY0EbpuMaNCImQ7EKTQYZc81ozkh+E=
-----END PUBLIC KEY-----
KEY
openssl pkeyutl -verify -pubin -inkey "$tmp/akeru-release-manifest.pub" -rawin \
  -in "$tmp/AKERU-REMOTE-MANIFEST.txt" -sigfile "$tmp/AKERU-REMOTE-MANIFEST.sig" >/dev/null
checksum_line="$(grep -E "^[a-fA-F0-9]{64}[[:space:]]+\\*?${archive}$" "$tmp/AKERU-REMOTE-MANIFEST.txt" || true)"
[ -n "$checksum_line" ] || { printf 'Release checksum is missing for %s.\n' "$archive" >&2; exit 1; }
verify_checksum "$(printf '%s\n' "$checksum_line" | awk '{print $1}')" "$tmp/$archive"
mkdir -p "$install_root/versions" "$bin_dir"
target="$install_root/versions/$version"
next="$target.next.$$"
rm -rf "$next"
mkdir -p "$next"
tar -xzf "$tmp/$archive" -C "$next" --strip-components=1
test -x "$next/akeru"
if [ "$prepare_only" -eq 0 ]; then
  mkdir -p "$runtime_home/userdata"
  identity_path="$runtime_home/userdata/remote-link-identity.json"
  AKERU_IDENTITY_NODE="$next/node/bin/node" \
    AKERU_REMOTE_ALLOW_IDENTITY_MIGRATION="$migrate_environment_id" \
    "$next/initialize-remote-identity.sh"
fi
if [ "$prepare_only" -eq 1 ] && [ -e "$target" ]; then
  rm -rf "$next"
else
  rm -rf "$target.previous"
  if [ -e "$target" ]; then mv "$target" "$target.previous"; fi
  mv "$next" "$target"
fi
if [ "$use_tailscale" -eq 1 ]; then printf 'tailscale\n' > "$target/REMOTE_MODE"
else printf 'direct\n' > "$target/REMOTE_MODE"; fi
if [ "$prepare_only" -eq 1 ]; then
  printf 'Prepared Akeru Remote %s for a transactional service update.\n' "$version"
  exit 0
fi
if [ -L "$bin_dir/akeru" ]; then
  previous_akeru="$(readlink "$bin_dir/akeru")"
  previous_root="$(dirname "$previous_akeru")"
  [ "$previous_root" = "$target" ] && previous_root="$target.previous"
  ln -sfn "$previous_root" "$install_root/previous"
fi
ln -sfn "$target/akeru" "$bin_dir/akeru"
umask 077
if [ "$use_tailscale" -eq 1 ]; then
  tailscale_cli="$(command -v tailscale 2>/dev/null || true)"
  if [ -z "$tailscale_cli" ] && [ "$platform" = darwin ] && [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then
    tailscale_cli=/Applications/Tailscale.app/Contents/MacOS/Tailscale
  fi
  tailscale() { TAILSCALE_BE_CLI=1 "$tailscale_cli" "$@"; }
  if [ -z "$tailscale_cli" ]; then
    if [ "$platform" = darwin ]; then
      package_page="$(curl --proto '=https' --tlsv1.2 -fsSL https://pkgs.tailscale.com/stable/)"
      tailscale_package="$(printf '%s' "$package_page" | sed -n 's/.*href="\([^"]*Tailscale-[0-9][^"]*-macos\.pkg\)".*/\1/p' | tail -1)"
      [ -n "$tailscale_package" ] || { printf 'Could not resolve the current Tailscale macOS package.\n' >&2; exit 1; }
      curl --proto '=https' --tlsv1.2 -fsSL -o "$tmp/tailscale.pkg" "https://pkgs.tailscale.com/stable/$tailscale_package"
      published_checksum="$(curl --proto '=https' --tlsv1.2 -fsSL "https://pkgs.tailscale.com/stable/$tailscale_package.sha256" | awk '{print $1}')"
      verify_checksum "$published_checksum" "$tmp/tailscale.pkg"
      printf 'Installing verified Tailscale for macOS (sudo may prompt)...\n'
      sudo installer -pkg "$tmp/tailscale.pkg" -target /
      tailscale_cli=/Applications/Tailscale.app/Contents/MacOS/Tailscale
      sudo mkdir -p /usr/local/bin
      sudo sh -c 'cat > /usr/local/bin/tailscale <<"EOF"
#!/bin/sh
TAILSCALE_BE_CLI=1 exec /Applications/Tailscale.app/Contents/MacOS/Tailscale "$@"
EOF
chmod 0755 /usr/local/bin/tailscale'
      open -a Tailscale
    else
      tailscale_version=1.88.4
      case "$arch" in x64) tailscale_arch=amd64 ;; arm64) tailscale_arch=arm64 ;; esac
      tailscale_archive="tailscale_${tailscale_version}_${tailscale_arch}.tgz"
      tailscale_url="https://pkgs.tailscale.com/stable/$tailscale_archive"
      tailscale_checksum="$(grep -E "^[a-fA-F0-9]{64}[[:space:]]+\\*?${tailscale_archive}$" "$tmp/AKERU-REMOTE-MANIFEST.txt" || true)"
      [ -n "$tailscale_checksum" ] || { printf 'The signed release manifest does not authorize the pinned Tailscale package.\n' >&2; exit 1; }
      curl --proto '=https' --tlsv1.2 -fsSL -o "$tmp/$tailscale_archive" "$tailscale_url"
      verify_checksum "$(printf '%s\n' "$tailscale_checksum" | awk '{print $1}')" "$tmp/$tailscale_archive"
      tar -xzf "$tmp/$tailscale_archive" -C "$tmp"
      tailscale_source="$tmp/tailscale_${tailscale_version}_${tailscale_arch}"
      printf 'Installing verified Tailscale %s (sudo may prompt)...\n' "$tailscale_version"
      sudo install -m 0755 "$tailscale_source/tailscale" /usr/bin/tailscale
      sudo install -m 0755 "$tailscale_source/tailscaled" /usr/sbin/tailscaled
      sudo install -m 0644 "$tailscale_source/systemd/tailscaled.service" /etc/systemd/system/tailscaled.service
      sudo install -m 0644 "$tailscale_source/systemd/tailscaled.defaults" /etc/default/tailscaled
      sudo systemctl daemon-reload
      sudo systemctl enable --now tailscaled
      tailscale_cli=/usr/bin/tailscale
    fi
  fi
  if [ "$platform" = darwin ] && [ ! -x /usr/local/bin/tailscale ]; then
    sudo mkdir -p /usr/local/bin
    sudo sh -c 'cat > /usr/local/bin/tailscale <<"EOF"
#!/bin/sh
TAILSCALE_BE_CLI=1 exec /Applications/Tailscale.app/Contents/MacOS/Tailscale "$@"
EOF
chmod 0755 /usr/local/bin/tailscale'
  fi
  if ! tailscale status >/dev/null 2>&1; then
    if [ "$platform" = linux ]; then sudo "$tailscale_cli" up; else tailscale up; fi
  fi
  if ! tailscale serve status --json > "$tmp/tailscale-serve.json" 2> "$tmp/tailscale-serve.stderr"; then
    grep -qi 'handler does not exist' "$tmp/tailscale-serve.stderr" || { printf 'Could not inspect existing Tailscale Serve ownership; Akeru will not change it.\n' >&2; exit 1; }
    printf '{}\n' > "$tmp/tailscale-serve.json"
  fi
  has_serve="$("$target/node/bin/node" -e 'const value=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")),web=value.Web; process.stdout.write(web&&typeof web==="object"&&Object.keys(web).some(key=>key.endsWith(":443"))?"yes":"no")' "$tmp/tailscale-serve.json")"
  if [ "$has_serve" = yes ]; then
    serve_record="$runtime_home/userdata/remote-serve.json"
    [ -s "$serve_record" ] || { printf 'Tailscale HTTPS port 443 already has a handler. Akeru will not replace it.\n' >&2; exit 1; }
    proxy_target="$("$target/node/bin/node" -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).proxyTarget||"")' "$serve_record")"
    [ -n "$proxy_target" ] || { printf 'The saved Serve record lacks a strict proxy target. Akeru will not replace port 443.\n' >&2; exit 1; }
    serve_match="$(EXPECTED="$proxy_target" "$target/node/bin/node" -e 'const value=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")),entries=Object.entries(value.Web||{}).filter(([key])=>key.endsWith(":443")); const handlers=entries[0]?.[1]?.Handlers; const items=handlers&&typeof handlers==="object"?Object.entries(handlers):[]; const handler=items[0]?.[1]; const exact=entries.length===1&&items.length===1&&items[0][0]==="/"&&handler&&typeof handler==="object"&&!Array.isArray(handler)&&Object.keys(handler).length===1&&handler.Proxy===process.env.EXPECTED; process.stdout.write(exact?"owned":"occupied")' "$tmp/tailscale-serve.json")"
    [ "$serve_match" = owned ] || { printf 'Tailscale HTTPS port 443 handler graph no longer exactly matches Akeru ownership. Akeru will not replace it.\n' >&2; exit 1; }
  fi
  :
else
  :
fi
if command -v systemctl >/dev/null 2>&1 && command -v loginctl >/dev/null 2>&1; then
  install_user="$(id -un)"
  if ! loginctl show-user "$install_user" -p Linger --value 2>/dev/null | grep -qx yes; then
    printf 'Enabling boot persistence for %s (sudo may prompt)...\n' "$install_user"
    sudo loginctl enable-linger "$install_user"
  fi
  loginctl show-user "$install_user" -p Linger --value | grep -qx yes || {
    printf 'Could not verify systemd user lingering; the service would not survive logout.\n' >&2
    exit 1
  }
fi
if [ "$use_tailscale" -eq 1 ]; then
  T3CODE_TAILSCALE_SERVE=true "$bin_dir/akeru" service install
else
  "$bin_dir/akeru" service install
fi
remote_endpoint=""
if [ "$use_tailscale" -eq 1 ]; then
  tailnet_name="$(tailscale status --json | "$target/node/bin/node" -e 'let value=""; process.stdin.on("data",chunk=>value+=chunk).on("end",()=>{const name=JSON.parse(value).Self?.DNSName; if(typeof name==="string") process.stdout.write(name.replace(/\.$/,""))})')"
  [ -z "$tailnet_name" ] || remote_endpoint="https://$tailnet_name"
fi
healthy=0
if [ -n "$remote_endpoint" ]; then
  attempts=0
  while [ "$attempts" -lt 30 ]; do
    if curl -fsS --max-time 3 "$remote_endpoint/" >/dev/null 2>&1; then healthy=1; break; fi
    attempts=$((attempts + 1))
    sleep 2
  done
elif command -v systemctl >/dev/null 2>&1 && systemctl --user is-active akeru-bot.service >/dev/null 2>&1; then
  healthy=1
fi
if [ "$healthy" -ne 1 ]; then
  previous="$(readlink "$install_root/previous" 2>/dev/null || true)"
  if [ -d "$previous" ]; then
    ln -sfn "$previous/akeru" "$bin_dir/akeru"
    if [ "$use_tailscale" -eq 1 ]; then
      T3CODE_TAILSCALE_SERVE=true "$bin_dir/akeru" service update || true
    else
      "$bin_dir/akeru" service update || true
    fi
    printf 'The new service failed its health check and Akeru restored the previous version.\n' >&2
  else
    printf 'The Akeru service did not become healthy. Run akeru remote doctor for details.\n' >&2
  fi
  exit 1
fi
if [ -n "$remote_endpoint" ]; then
  environment_id="$(cat "$runtime_home/userdata/environment-id")"
  runtime_port="$("$target/node/bin/node" -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).port))' "$runtime_home/userdata/server-runtime.json")"
  ENVIRONMENT_ID="$environment_id" HTTP_ENDPOINT="$remote_endpoint" PROXY_TARGET="http://127.0.0.1:$runtime_port" "$target/node/bin/node" -e 'process.stdout.write(JSON.stringify({environmentId:process.env.ENVIRONMENT_ID,endpoint:process.env.HTTP_ENDPOINT,httpsPort:443,proxyTarget:process.env.PROXY_TARGET})+"\n")' > "$runtime_home/userdata/remote-serve.json"
fi
if [ "$install_updates" -eq 1 ] && command -v systemctl >/dev/null 2>&1; then
  unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$unit_dir"
  cat > "$unit_dir/akeru-update.service" <<SERVICE
[Unit]
Description=Update Akeru Remote
[Service]
Type=oneshot
Environment=$(systemd_quote "AKERU_HOME=$runtime_home")
ExecStart=$(systemd_quote "$bin_dir/akeru") remote update
SERVICE
  cat > "$unit_dir/akeru-update.timer" <<TIMER
[Unit]
Description=Check Akeru Remote updates
[Timer]
OnBootSec=15m
OnUnitActiveSec=1h
RandomizedDelaySec=30m
Persistent=true
[Install]
WantedBy=timers.target
TIMER
  systemctl --user daemon-reload
  systemctl --user enable --now akeru-update.timer
elif [ "$install_updates" -eq 1 ] && [ "$platform" = darwin ]; then
  agent_dir="$HOME/Library/LaunchAgents"
  mkdir -p "$agent_dir"
  job=update
  interval=3600
  label="dev.leodoes.akeru.remote.$job"
  plist="$agent_dir/$label.plist"
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$label</string>
<key>EnvironmentVariables</key><dict><key>AKERU_HOME</key><string>$runtime_home</string></dict>
<key>ProgramArguments</key><array><string>$bin_dir/akeru</string><string>remote</string><string>$job</string></array>
<key>StartInterval</key><integer>$interval</integer><key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>$runtime_home/userdata/logs/remote-$job.log</string>
<key>StandardErrorPath</key><string>$runtime_home/userdata/logs/remote-$job.log</string>
</dict></plist>
EOF
  launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
fi
printf '\nAkeru Remote %s is installed.\n' "$version"
printf 'Pair your first admin device: akeru pair --admin --tailscale\n'
printf 'Pair more devices later: akeru pair --tailscale\n'
printf 'Diagnostics: akeru remote doctor\n'
