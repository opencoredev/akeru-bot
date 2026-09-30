#!/bin/sh
set -eu
command_name="${1:-help}"
shift || true
base_dir="${AKERU_HOME:-$HOME/.akeru}"
# The server and service launcher read T3CODE_HOME; always derive it from the Akeru home so an
# ambient T3 Code home can never redirect remote administration.
T3CODE_HOME="$base_dir"
export T3CODE_HOME
userdata="$base_dir/userdata"
version="$(cat "$(dirname "$0")/VERSION" 2>/dev/null || printf unknown)"
node_bin="$(dirname "$0")/node/bin/node"
artifact_root="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
server_entry="${AKERU_SERVER_ENTRYPOINT:-$artifact_root/node_modules/akeru-bot/dist/bin.mjs}"
launcher_entry="${AKERU_LAUNCHER_ENTRYPOINT:-$artifact_root/node_modules/akeru-bot/dist/service-launcher.mjs}"
server_command="${AKERU_SERVER_COMMAND:-$artifact_root/akeru}"
install_root="${AKERU_INSTALL_ROOT:-$(CDPATH= cd -- "$artifact_root/../.." && pwd)}"
bin_dir="${AKERU_BIN_DIR:-$HOME/.local/bin}"
active_version() {
  state="$base_dir/runtime/service-state.json"
  if [ -s "$state" ]; then
    resolved="$($node_bin -e 'const fs=require("node:fs"); try { const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(value.protocol===2&&typeof value.activeVersion==="string"&&/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value.activeVersion)) process.stdout.write(value.activeVersion) } catch {}' "$state")"
    [ -z "$resolved" ] || { printf '%s' "$resolved"; return; }
  fi
  printf '%s' "$version"
}
serve_graph_state() {
  port="$1"; expected="$2"; status_file="${TMPDIR:-/tmp}/akeru-serve-status.$$"
  if ! tailscale serve status --json >"$status_file" 2>"$status_file.err"; then
    if grep -qi 'handler does not exist' "$status_file.err"; then rm -f "$status_file" "$status_file.err"; printf absent; return; fi
    rm -f "$status_file" "$status_file.err"; printf unreadable; return
  fi
  PORT="$port" EXPECTED="$expected" "$node_bin" -e 'const fs=require("node:fs"); try { const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8")),web=value.Web; if(!web||typeof web!=="object"){process.stdout.write("absent");process.exit()} const entries=Object.entries(web).filter(([key])=>key.endsWith(`:${process.env.PORT}`)); if(entries.length===0){process.stdout.write("absent");process.exit()} if(entries.length!==1){process.stdout.write("occupied");process.exit()} const handlers=entries[0][1]?.Handlers; if(!handlers||typeof handlers!=="object"){process.stdout.write("occupied");process.exit()} const items=Object.entries(handlers); const handler=items[0]?.[1]; const exact=items.length===1&&items[0][0]==="/"&&handler&&typeof handler==="object"&&!Array.isArray(handler)&&Object.keys(handler).length===1&&handler.Proxy===process.env.EXPECTED; process.stdout.write(exact?"owned":"occupied") } catch { process.stdout.write("unreadable") }' "$status_file"
  rm -f "$status_file" "$status_file.err"
}
case "$command_name" in
  doctor)
    exec "$node_bin" "$server_entry" __remote-doctor "$@"
    ;;
  status)
    if [ "${AKERU_REMOTE_CONTAINER:-0}" = 1 ]; then
      exec "$node_bin" "$server_entry" __remote-doctor "$@"
    fi
    "$0" doctor || true
    exec "$server_command" service status
    ;;
  logs)
    # `akeru service install` names the unit akeru-bot.service (t3code.service before the rename)
    # and appends the server output to this file, so journald only holds unit events.
    log="$userdata/logs/boot-service.log"
    [ -f "$log" ] && exec tail -n "${AKERU_LOG_LINES:-200}" "$log"
    if command -v journalctl >/dev/null 2>&1; then
      exec journalctl --user -u akeru-bot.service -u t3code.service -n "${AKERU_LOG_LINES:-200}" --no-pager
    fi
    printf 'No service log was found.\n' >&2; exit 1
    ;;
  link|heartbeat|unlink)
    printf 'Hosted account linking is not part of self-hosted Akeru Remote; pair directly with akeru pair.\n' >&2
    exit 2
    ;;
  update)
    [ "${AKERU_REMOTE_CONTAINER:-0}" != 1 ] || { printf 'Docker manages Akeru updates by changing the image tag; use the documented Compose update flow.\n' >&2; exit 2; }
    repo="${AKERU_REMOTE_REPOSITORY:-opencoredev/akeru-bot}"
    tag="$(curl -fsSL "https://api.github.com/repos/$repo/releases/latest" | sed -n 's/.*"tag_name":[[:space:]]*"\(v[0-9][^"]*\)".*/\1/p' | head -1)"
    [ -n "$tag" ] || { printf 'Could not resolve the latest Akeru release.\n' >&2; exit 1; }
    target_version="${tag#v}"
    current_version="$(active_version)"
    if [ "$target_version" = "$current_version" ]; then
      rm -f "$userdata/remote-update-deferred-at"
      printf 'Akeru Remote %s is already current.\n' "$current_version"
      exit 0
    fi
    mode="$(cat "$artifact_root/REMOTE_MODE" 2>/dev/null || printf tailscale)"
    if [ "$mode" = tailscale ]; then
      AKERU_INSTALL_ROOT="$install_root" AKERU_BIN_DIR="$bin_dir" AKERU_REMOTE_REPOSITORY="$repo" \
        "$artifact_root/install-remote.sh" --prepare-only --tag "$tag"
    else
      AKERU_INSTALL_ROOT="$install_root" AKERU_BIN_DIR="$bin_dir" AKERU_REMOTE_REPOSITORY="$repo" \
        "$artifact_root/install-remote.sh" --prepare-only --no-tailscale --tag "$tag"
    fi
    runtime_state="$userdata/server-runtime.json"
    control_token="$userdata/remote-control-token"
    [ -s "$runtime_state" ] && [ -s "$control_token" ] || {
      printf 'The running service state or update credential is missing. Run akeru remote doctor --repair.\n' >&2; exit 1; }
    origin="$("$node_bin" -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(`http://127.0.0.1:${v.port}`)' "$runtime_state")"
    response_file="$(mktemp "${TMPDIR:-/tmp}/akeru-update.XXXXXX")"
    trap 'rm -f "$response_file"' EXIT HUP INT TERM
    status="$(TARGET_VERSION="$target_version" "$node_bin" -e 'process.stdout.write(JSON.stringify({targetVersion:process.env.TARGET_VERSION}))' | curl -sS -o "$response_file" -w '%{http_code}' -X POST "$origin/api/remote/update" -H "x-akeru-machine-token: $(cat "$control_token")" -H 'content-type: application/json' --data-binary @-)"
    if [ "$status" = 409 ]; then
      deferred="$userdata/remote-update-deferred-at"
      [ -s "$deferred" ] || date -u +%Y-%m-%dT%H:%M:%SZ > "$deferred"
      deferred_age_seconds="$("$node_bin" -e 'const value=require("fs").readFileSync(process.argv[1],"utf8").trim(); process.stdout.write(String(Math.max(0,Math.floor((Date.now()-Date.parse(value))/1000))))' "$deferred")"
      if [ "$deferred_age_seconds" -ge 86400 ]; then
        printf 'Update %s exceeded its 24-hour maintenance deadline while bot work remained active. Run akeru remote doctor.\n' "$target_version" >&2
        exit 1
      fi
      printf 'Update %s deferred because a bot turn is active; the hourly timer will retry.\n' "$target_version"
      exit 0
    fi
    [ "$status" = 202 ] || { cat "$response_file" >&2; printf '\nAkeru update request failed with HTTP %s.\n' "$status" >&2; exit 1; }
    rm -f "$userdata/remote-update-deferred-at"
    cat "$response_file"
    printf '\nAkeru Remote update %s entered the transactional launcher.\n' "$target_version"
    ;;
  rollback)
    [ "${AKERU_REMOTE_CONTAINER:-0}" != 1 ] || { printf 'Docker manages rollback by restoring the prior image and data snapshot; use the documented Compose rollback flow.\n' >&2; exit 2; }
    state="$base_dir/runtime/service-state.json"
    [ -s "$state" ] || { printf 'No transactional launcher state is available.\n' >&2; exit 1; }
    "$server_command" service uninstall
    if ! "$node_bin" "$launcher_entry" --manual-rollback; then
      "$server_command" service install || true
      printf 'Transactional rollback failed; the service was restarted without changing launcher state.\n' >&2
      exit 1
    fi
    mode="$(cat "$artifact_root/REMOTE_MODE" 2>/dev/null || printf tailscale)"
    if [ "$mode" = tailscale ]; then AKERU_TAILSCALE_SERVE=true "$server_command" service install
    else "$server_command" service install; fi
    printf 'Rolled back the Akeru runtime and database snapshot.\n'
    ;;
  uninstall)
    [ "${AKERU_REMOTE_CONTAINER:-0}" != 1 ] || { printf 'Docker manages removal through Compose; run remote unlink first, then remove the Compose stack.\n' >&2; exit 2; }
    purge=0; [ "${1:-}" = "--purge-data" ] && purge=1
    serve_config="$userdata/remote-serve.json"
    if [ -s "$serve_config" ]; then
      endpoint="$("$node_bin" -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).endpoint)' "$serve_config")"
      environment_id="$("$node_bin" -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).environmentId)' "$serve_config")"
      serve_port="$("$node_bin" -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).httpsPort))' "$serve_config")"
      serve_target="$("$node_bin" -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).proxyTarget||"")' "$serve_config")"
      [ -n "$serve_target" ] || { printf 'Refusing to remove a Serve mapping without a strict proxy ownership record.\n' >&2; exit 1; }
      graph_state="$(serve_graph_state "$serve_port" "$serve_target")"
      case "$graph_state" in absent) ;; owned) tailscale serve --https="$serve_port" off ;; *) printf 'Refusing to remove a Tailscale mapping whose handler graph changed.\n' >&2; exit 1 ;; esac
      rm -f "$serve_config"
    fi
    "$server_command" service uninstall
    if command -v systemctl >/dev/null 2>&1; then
      systemctl --user disable --now akeru-update.timer akeru-heartbeat.timer >/dev/null 2>&1 || true
      rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/akeru-update.service" \
        "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/akeru-update.timer"
      rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/akeru-heartbeat.service" \
        "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/akeru-heartbeat.timer"
      systemctl --user daemon-reload
    elif command -v launchctl >/dev/null 2>&1; then
      for job in update heartbeat; do
        label="dev.leodoes.akeru.remote.$job"
        launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
        rm -f "$HOME/Library/LaunchAgents/$label.plist"
      done
    fi
    rm -f "$bin_dir/akeru"
    rm -rf "$install_root"
    [ "$purge" -eq 0 ] || rm -rf "$base_dir"
    printf 'Removed Akeru Remote%s.\n' "$([ "$purge" -eq 1 ] && printf ' and its data' || true)"
    ;;
  help|-h|--help)
    printf 'Usage: akeru remote {doctor|status|logs|update|rollback|uninstall}\n'
    ;;
  *)
    printf 'Usage: akeru remote {doctor|status|logs|update|rollback|uninstall}\n' >&2
    exit 2 ;;
esac
