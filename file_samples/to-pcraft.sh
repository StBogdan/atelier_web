#!/bin/sh
# Turn the PSD/PSB samples into the .pcraft documents Atelier Cloud seeds a workspace with.
#
# The provider stores a project's document as a `.pcraft` (contract 3.2), and the browser cannot
# convert a PSD, so the conversion happens once here, with the editor's own headless CLI, and the
# results are committed under web/static/samples/ for the landing page to fetch.
#
#   ./to-pcraft.sh                 uses ../photocraft/target/release/photocraft-cli
#   PHOTOCRAFT_CLI=/path ./to-pcraft.sh
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
CLI=${PHOTOCRAFT_CLI:-$HERE/../../photocraft/target/release/photocraft-cli}
OUT="$HERE/../web/static/samples"

[ -x "$CLI" ] || {
	printf 'no headless CLI at %s\nbuild it once: cd ../photocraft && cargo build --release -p photocraft-cli\n' "$CLI" >&2
	exit 1
}

mkdir -p "$OUT"
for source in "$HERE"/*.psd "$HERE"/*.psb; do
	[ -e "$source" ] || continue
	name=$(basename "$source")
	stem=${name%.*}
	"$CLI" convert "$source" "$OUT/$stem.pcraft"
	printf '%s → %s.pcraft\n' "$name" "$stem"
done

# The landing page reads this rather than hard-coding the three.
{
	printf '{\n  "samples": [\n'
	first=1
	for file in "$OUT"/*.pcraft; do
		stem=$(basename "$file" .pcraft)
		[ "$first" = 1 ] || printf ',\n'
		first=0
		printf '    { "file": "%s.pcraft", "name": "%s", "bytes": %s }' "$stem" "$stem" "$(wc -c <"$file" | tr -d ' ')"
	done
	printf '\n  ]\n}\n'
} >"$OUT/index.json"

printf 'wrote %s\n' "$OUT/index.json"
