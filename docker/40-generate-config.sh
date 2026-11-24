#!/bin/sh
# Runs automatically before nginx starts (official nginx image runs /docker-entrypoint.d/*.sh).
# Writes /usr/share/nginx/html/config.js from the BACKEND_WS_URL environment variable.
set -e

OUT=/usr/share/nginx/html/config.js
URL="${BACKEND_WS_URL:-wss://airplaneludo-backend.onrender.com/ludo}"

# Be forgiving: accept http(s) URLs and a missing /ludo suffix.
case "$URL" in
  https://*) URL="wss://${URL#https://}" ;;
  http://*)  URL="ws://${URL#http://}" ;;
esac
case "$URL" in
  ws://*|wss://*|/*) ;;
  *) echo "[config] ERROR: BACKEND_WS_URL must start with ws://, wss:// or / (got: $URL)" >&2; exit 1 ;;
esac
URL="${URL%/}"
case "$URL" in
  */ludo) ;;
  *) URL="$URL/ludo" ;;
esac

ESC=$(printf '%s' "$URL" | sed 's/\\/\\\\/g; s/"/\\"/g')
printf 'window.APP_CONFIG = {\n  BACKEND_WS_URL: "%s"\n};\n' "$ESC" > "$OUT"
echo "[config] BACKEND_WS_URL=$URL"
