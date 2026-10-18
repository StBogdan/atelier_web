#!/bin/sh
# Run Atelier Cloud and the editor together on one origin (http://127.0.0.1:3000).
#
# Ensures the editor is up, then starts Atelier web in the foreground. Ctrl-C stops Atelier web;
# the editor container keeps running (`docker stop photocraft-web`).
set -eu
cd "$(dirname "$0")"

CONTAINER=photocraft-web
PORT="${ATELIER_PORT:-3000}"
WEB_DIR="${ATELIER_WEB_DIR:-web/build}"
# Where the editor is, which is also what Atelier web proxies. The default is the container.
UPSTREAM="${PHOTOCRAFT_UPSTREAM:-http://127.0.0.1:8080}"

say() { printf '%s\n' "$*"; }

if ! command -v npm >/dev/null 2>&1; then
  say "The cloud app is served from $WEB_DIR, and npm is missing to build it."
  say "    cd web && npm install && npm run build"
  say ""
elif [ ! -f "$WEB_DIR/index.html" ] || [ -n "$(find web/src web/static web/package.json -newer "$WEB_DIR/index.html" -print -quit 2>/dev/null)" ]; then
  # Built here rather than served stale: this script is the one that serves it, and a page that
  # disagrees with the editor it shares an origin with is the confusing case.
  say "cloud app: building into $WEB_DIR"
  [ -d web/node_modules ] || (cd web && npm install)
  (cd web && npm run build)
else
  say "cloud app: $WEB_DIR is up to date with its sources"
fi

if ! command -v docker >/dev/null 2>&1; then
  say "docker not found: start the editor some other way, then"
  say "  PHOTOCRAFT_UPSTREAM=http://127.0.0.1:8765 ./run.sh"
elif docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  # Say what this is: the upstream image, built when it was built, with no patch and no cloudspace.
  # It is the fallback, not the editor the rest of this repository builds — the root ../run.sh does
  # that, and its About line names the commit it was built from.
  say "editor: $CONTAINER is already running — the upstream image, not the patched editor"
  say "        (the root ../run.sh builds the patched one; it is what shows a cloudspace)"
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
# This is the upstream Atelier web actually proxies, which is not the container when
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
  say "editor: $UPSTREAM is not answering; starting Atelier web anyway"
  say "        /cloud/ works regardless; /photocraft/ shows how to start the editor."
fi

say ""
say "Atelier Cloud  →  http://127.0.0.1:$PORT/cloud/"
say "PhotoCraft     →  http://127.0.0.1:$PORT/photocraft/"
if [ -n "${PDFCRAFT_UPSTREAM:-}" ]; then
  say "PdfCraft       →  http://127.0.0.1:$PORT/pdfcraft/"
fi
say ""

exec cargo run --release --manifest-path server/Cargo.toml
