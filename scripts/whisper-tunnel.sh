#!/usr/bin/env bash
# Local dictation needs a path to whisper-svc, which binds 127.0.0.1 on its
# own machine (.2). The Next route (app/api/stt/transcribe) talks to
# STT_BASE_URL — by default http://127.0.0.1:8280 — so keep this forward up
# while the app runs. Run it under systemd/nohup if the app is long-lived.
set -euo pipefail

STT_HOST="${STT_HOST:-cupc@192.168.1.2}"
STT_REMOTE_PORT="${STT_REMOTE_PORT:-8280}"
STT_LOCAL_PORT="${STT_LOCAL_PORT:-8280}"

exec ssh -N \
	-o ExitOnForwardFailure=yes \
	-o ServerAliveInterval=30 \
	-o ServerAliveCountMax=3 \
	-L "${STT_LOCAL_PORT}:127.0.0.1:${STT_REMOTE_PORT}" \
	"${STT_HOST}"
