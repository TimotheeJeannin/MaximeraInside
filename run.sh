#!/usr/bin/env bash
# Serves the tool locally and opens it in the default browser. Ctrl+C to stop.
set -e
cd "$(dirname "$0")"
PORT="${PORT:-8123}"
URL="http://localhost:$PORT/"

(sleep 1 && xdg-open "$URL" >/dev/null 2>&1) &
echo "Serving $URL - press Ctrl+C to stop."
exec python3 -m http.server "$PORT" --bind 127.0.0.1
