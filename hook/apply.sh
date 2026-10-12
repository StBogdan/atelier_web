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
# Recorded upstream ref: v0.7.0-150-ge2644265, the pin in the outer repository's .gitmodules.
PINNED_REF=e26442657f39d04716656baf749d3268ee3f8a0f
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
		# `--3way` stages what it applies; unstage, so `revert` is a plain checkout.
		git_in apply --3way "$PATCH" && git_in reset -q
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
	trunk build --release
	say "built into $CHECKOUT/dist/web"
	;;
*)
	die "usage: $0 check|apply|revert|build [ref]"
	;;
esac
