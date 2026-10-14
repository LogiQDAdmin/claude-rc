#!/bin/sh
set -eu
umask 077
# These paths are part of the image contract, not selected from user credentials.
export HOME=/data/home CLAUDE_CONFIG_DIR=/data/claude CLAUDE_BINARY=/opt/claude/claude
export CODEX_USER_HOME=/data/codex-home CODEX_HOME=/data/codex CODEX_BINARY=/opt/codex/codex
export DISABLE_UPDATES=1 DISABLE_AUTOUPDATER=1
# The helper emits only fixed, application-owned export statements. Diagnostics
# go to stderr; no external strings, paths or credentials become shell code.
eval "$(node /app/scripts/init-runtime.mjs)"
exec "$@"
