#!/bin/sh
# Apply, check or revert the Atelier Cloud patch against a PhotoCraft checkout (design, The PhotoCraft Patch, Keeping the Patch Re-appliable).
#
#   ./apply.sh check [ref]    does the patch still apply to `ref`? (3-way, nothing committed)
#   ./apply.sh apply [ref]    check `ref` out and apply the patch, for a build
#   ./apply.sh revert         return the checkout to pristine upstream
#   ./apply.sh build [ref]    apply, then `trunk build --release` the editor
#
# `ref` defaults to the upstream commit the patch was written against, which is the commit the outer
# repository pins as its submodule. Nothing here ever commits.
#
# The checkout is `../photocraft` unless PHOTOCRAFT_DIR says otherwise. Point that at a scratch
# clone or a git worktree to keep the pinned submodule clean, as README.md describes; CARGO_TARGET_DIR
# is passed through, so a scratch worktree can share the target directory of a warm build.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
PATCH="$HERE/atelier_web.patch"
CHECKOUT=${PHOTOCRAFT_DIR:-$HERE/../../photocraft}
# Recorded upstream ref: v0.16.0, the pin in the outer repository.
PINNED_REF=b1794c6e0608ccfc887213dcf58398977c5cb75e
# The one file the patch adds, so `revert` knows what to remove.
ADDED_FILE=apps/photocraft-web/src/atelier_cloud.rs

say() { printf '%s\n' "$*"; }
die() {
	printf '%s\n' "$*" >&2
	exit 1
}

[ -e "$CHECKOUT/.git" ] || die "not a git checkout: $CHECKOUT (set PHOTOCRAFT_DIR)"
[ -f "$PATCH" ] || die "missing patch: $PATCH"

git_in() { git -C "$CHECKOUT" "$@"; }

# The checkout must be clean: applying and reverting would otherwise throw away someone's work.
require_clean() {
	DIRTY=$(git_in status --porcelain || true)
	[ -z "$DIRTY" ] || die "$CHECKOUT has local changes; ./apply.sh revert first: $DIRTY"
}

checkout_ref() {
	if [ "$(git_in rev-parse HEAD)" != "$(git_in rev-parse "$1^{commit}")" ]; then
		git_in checkout --detach "$1" >/dev/null
		say "checked out $(git_in rev-parse --short HEAD) ($1)"
	fi
}

apply() {
	if git_in apply --3way --check "$PATCH" 2>/dev/null; then
		# `--3way --check` reports success even for a merge that would conflict, so the real apply
		# decides. `--3way` stages what it applies; unstage, so `revert` is a plain checkout.
		if git_in apply --3way "$PATCH" 2>/dev/null; then
			git_in reset -q
		else
			# A conflicted merge leaves markers and unmerged entries; clear them before saying so.
			git_in reset -q
			git_in checkout -- . 2>/dev/null || true
			rm -f "$CHECKOUT/$ADDED_FILE"
			die "the patch conflicts with $(git_in rev-parse --short HEAD): upstream moved inside a hunk.
   A 3-way merge fitted most of it and left conflicts in the rest, so this is drift to reconcile by
   hand (README.md, When upstream moves), not a clean application."
		fi
	elif git_in apply --check "$PATCH" 2>/dev/null; then
		git_in apply "$PATCH"
	else
		die "the patch does not apply to $(git_in rev-parse --short HEAD).
   A 3-way merge needs the ref the patch was written against in the object database, which a shallow
   clone of another branch does not have: git fetch origin $PINNED_REF
   Then run this again. README.md has the drift note."
	fi
	say "applied $(basename "$PATCH") to $(git_in rev-parse --short HEAD)"
}

revert() {
	git_in reset -q
	git_in checkout -- .
	rm -f "$CHECKOUT/$ADDED_FILE"
	say "reverted $CHECKOUT to $(git_in rev-parse --short HEAD)"
}

case "${1:-}" in
check)
	require_clean
	checkout_ref "${2:-$PINNED_REF}"
	apply
	revert
	say "check ok: the patch applies cleanly to ${2:-$PINNED_REF}"
	;;
apply)
	require_clean
	checkout_ref "${2:-$PINNED_REF}"
	apply
	;;
revert)
	revert
	;;
build)
	require_clean
	checkout_ref "${2:-$PINNED_REF}"
	apply
	say "building (trunk build --release)…"
	cd "$CHECKOUT/apps/photocraft-web"
	# Provenance, so the About dialog names the commit this build came from instead of "(dev build)".
	# Upstream's own packaging does this in `packaging/env.sh`. Without it every local build reports the
	# last *release* number as a dev build: a build of the pin before v0.8.2 says "0.7.0 (dev build)",
	# which reads as an old editor when it is really a newer commit than the version implies.
	PHOTOCRAFT_BUILD_SHA=$(git_in rev-parse HEAD)
	PHOTOCRAFT_BUILD_DATE=$(date -u +%Y-%m-%d)
	export PHOTOCRAFT_BUILD_SHA PHOTOCRAFT_BUILD_DATE
	trunk build --release
	say "built into $CHECKOUT/dist/web — About reports $(git_in rev-parse --short HEAD), $PHOTOCRAFT_BUILD_DATE"
	;;
*)
	die "usage: $0 check|apply|revert|build [ref]"
	;;
esac
