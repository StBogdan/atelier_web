#!/bin/sh
# Run Atelier Cloud and the editor together on one origin (http://127.0.0.1:3000).
#
# Ensures the editor is up, then starts the front door in the foreground. Ctrl-C stops the
# front door; the editor container keeps running (`docker stop photocraft-web`).
set -eu
cd "$(dirname "$0")"

CONTAINER=photocraft-web
PORT="${ATELIER_PORT:-3000}"

say() { printf '%s\n' "$*"; }

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

# Wait for the editor to answer so the first page load does not hit the "not reachable" page.
i=0
while [ "$i" -lt 20 ]; do
  if curl -fsS -o /dev/null "http://127.0.0.1:8080/healthz" 2>/dev/null; then
    say "editor: healthy on :8080"
    break
  fi
  i=$((i + 1))
  sleep 1
done

say ""
say "Atelier Cloud  →  http://127.0.0.1:$PORT/cloud/"
say "Editor         →  http://127.0.0.1:$PORT/"
say "Open the first one and use the second from there, so both share one OPFS."
say ""

exec cargo run --release --manifest-path server/Cargo.toml
