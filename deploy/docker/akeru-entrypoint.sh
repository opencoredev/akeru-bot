#!/bin/sh
set -eu
# Akeru state lives in AKERU_HOME. The server reads T3CODE_HOME, so derive it here and never
# inherit an ambient T3 Code home.
AKERU_HOME="${AKERU_HOME:-$HOME/.akeru}"
T3CODE_HOME="$AKERU_HOME"
export AKERU_HOME T3CODE_HOME
if [ "${AKERU_REMOTE_IDENTITY_READY:-0}" != 1 ]; then
  AKERU_REMOTE_IDENTITY_READY=1 AKERU_IDENTITY_NODE="$(command -v node)" \
    /opt/akeru/initialize-remote-identity.sh
  export AKERU_REMOTE_IDENTITY_READY
fi
if [ "$#" -gt 0 ] && [ "$1" = remote ]; then
  shift
  exec /opt/akeru/remote-admin "$@"
fi
exec node /opt/akeru/node_modules/akeru-bot/dist/bin.mjs "$@"
