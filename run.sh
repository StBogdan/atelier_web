#!/bin/sh
# Run Atelier Cloud and the editor together on one origin (http://127.0.0.1:3000).
#
# Ensures the editor is up, then starts the front door in the foreground. Ctrl-C stops the
# front door; the editor container keeps running (`docker stop photocraft-web`).
set -eu
cd "$(dirname "$0")"

CONTAINER=photocraft-web
PORT="${ATELIER_PORT:-3000}"
WEB_DIR="${ATELIER_WEB_DIR:-web/build}"
# Where the editor is, which is also what the front door proxies. The default is the container.
UPSTREAM="${PHOTOCRAFT_UPSTREAM:-http://127.0.0.1:8080}"

say() { printf '%s\n' "$*"; }

if [ ! -f "$WEB_DIR/index.html" ]; then
  say "The cloud app is not built: $WEB_DIR/index.html is missing."
  say "    cd web && npm install && npm run build"
  say ""
fi

if ! command -v docker >/dev/null 2>&1; then
  say "docker not found: start the editor some other way, then"
  say "  PHOTOCRAFT_UPSTREAM=http://127.0.0.1:8765 ./run.sh"
elif docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  say "editor: $CONTAINER is already running"
elif docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  say "editor: starting $CONTAINER…"
  docker start "$CONTAINER" >/dev/null
else
  say "The editor container '$CONTAINER' does not exist yet. Build it once with:"
  say "    cd ../photocraft && docker build --load -t photocraft-web:local . \\"
  say "      && docker run -d --name $CONTAINER -p 8080:8080 photocraft-web:local"
  say ""
  say "Or run the editor from source with 'trunk serve' and point this at it:"
  say "    PHOTOCRAFT_UPSTREAM=http://127.0.0.1:8765 ./run.sh"
  exit 1
fi

# Wait for the editor to answer, so the first page load does not hit the "not reachable" page.
# This is the upstream the front door actually proxies, which is not the container when
# PHOTOCRAFT_UPSTREAM points at a `trunk serve` or a patched build.
i=0
healthy=0
while [ "$i" -lt 20 ]; do
  if curl -fsS -o /dev/null "$UPSTREAM/healthz" 2>/dev/null; then
    healthy=1
    say "editor: healthy at $UPSTREAM"
    break
  fi
  i=$((i + 1))
  sleep 1
done
if [ "$healthy" = 0 ]; then
  say "editor: $UPSTREAM is not answering; starting the front door anyway"
  say "        /cloud/ works regardless; / shows how to start the editor."
fi

say ""
say "Atelier Cloud  →  http://127.0.0.1:$PORT/cloud/"
say "Editor         →  http://127.0.0.1:$PORT/"
say "Open the first one and use the second from there, so both share one OPFS."
say ""

exec cargo run --release --manifest-path server/Cargo.toml
