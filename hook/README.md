# The PhotoCraft patch

One new file and three small hunks, applied to a PhotoCraft checkout. Design [The PhotoCraft Patch](../../docs/atelier_web_design.md#the-photocraft-patch) (what it does) and
[Keeping the Patch Re-appliable](../../docs/atelier_web_design.md#keeping-the-patch-re-appliable) (why it stays this small).

```
atelier_web.patch          the patch, a `git diff` against the recorded upstream ref
apply.sh                   apply / check / revert / build it against any ref
```

## What it touches

| File | Change |
|---|---|
| `apps/photocraft-web/src/atelier_cloud.rs` | new, 423 lines: the whole cloudspace hook |
| `apps/photocraft-web/src/main.rs` | one line: `mod atelier_cloud;` |
| `apps/photocraft-web/src/web.rs` | `services()`: `file_dialog` and `write` route through the module |
| `apps/photocraft-web/Cargo.toml` | the `web-sys` features the OPFS bindings need |

The design's [Patch Shape](../../docs/atelier_web_design.md#patch-shape) counts "one new file + three small hunks" and this is one new file + three hunks;
because the two `web.rs` edits are 34 lines apart, `git diff` folds them into a single hunk, so the
`Cargo.toml` feature list is the third. It has to be there: `FileSystemDirectoryHandle`,
`FileSystemFileHandle` and `FileSystemWritableFileStream` are the bindings design [Keeping the Patch Re-appliable](../../docs/atelier_web_design.md#keeping-the-patch-re-appliable) names, and none
of them is switched on for the web runner today. Features are not dependencies, so nothing is added to
the wasm dependency graph.

Nothing in `crates/*` is touched, so the patch cannot conflict with engine or UI work. It speaks only
the contract names in `../contract/protocol.md`, never provider internals, so a provider release
cannot force a patch release.

`web.rs` after the patch, in full:

```rust
file_dialog: Some(Box::new({
    crate::atelier_cloud::start(inbox.clone());
    move |request, _parent, reply| match request {
        request if crate::atelier_cloud::claims(&request) => crate::atelier_cloud::answer(request, reply),
        /* the browser's picker, unchanged */
    }
})),
write: Some(Box::new(|path: &str, bytes: &[u8]| match crate::atelier_cloud::target(path) {
    Some((project, document)) => crate::atelier_cloud::write(&project, &document, bytes),
    None => download(path, bytes),
})),
```

## What it does

`?project=<id>` binds the page to that project: the module reads `atelier-cloud/provider.json`,
checks the protocol version, takes the single `*.pcraft` in `projects/<id>/` and hands its bytes to
the `Inbox`. The app drains the inbox every frame, so the document opens as a normal one. A save
whose path is `atelier-cloud://<id>/<name>` writes back into that project.

Three details worth knowing before changing it:

- **Selection stays the provider's job.** `File ▸ Open` in a bound page re-opens the project's
  document; unbound, it is the browser's picker, unchanged. Drag-and-drop is unchanged in both.
- **Only document formats stay in the project.** A save to `.pcraft`, `.psd`, `.psb` or `.ora` goes
  to OPFS; Export As (PNG, JPEG, TIFF, TGA, WebP) still downloads, as it did.
- **The write is asynchronous.** OPFS cannot be written synchronously from the main thread and the
  editor's `Services::write` is synchronous, so the module schedules the write and reports success.
  What actually happened to the file is the provider's to derive from the filesystem (design [File Ownership](../../docs/atelier_web_design.md#file-ownership)).

The save follows the [Saving](../../docs/atelier_web_design.md#saving) sequence: exclusive Web Lock, `.prev` beside the document, `tmp/<uuid>`
staging, then the document. `FileSystemWritableFileStream::close()` swaps the finished file in, so
the document is never seen half-written.

## Using it

To run the patched editor, you rarely need this script: `../../run.sh` at the repository root does the
worktree, the build and the server for you, and starts the front door pointed at it. This script is for
doing it by hand, or against a different ref.

```sh
./apply.sh check            # the patch still applies to the recorded ref? (3-way, reverts after)
./apply.sh build            # apply, then trunk build --release into photocraft/dist/web
./apply.sh revert           # pristine upstream again
PHOTOCRAFT_DIR=... ./apply.sh check <ref>     # against another checkout or ref
```

Keep the pinned submodule clean. Use a scratch checkout:

```sh
cd ../photocraft
git worktree add --detach /tmp/photocraft-hook <ref>
cd ../atelier_web
CARGO_TARGET_DIR=../photocraft/target PHOTOCRAFT_DIR=/tmp/photocraft-hook ./hook/apply.sh build
```

Then serve the patched build and point the front door at it, so the editor and Atelier Cloud still
share one origin:

```sh
cd ../photocraft/dist/web && python3 -m http.server 8765
PHOTOCRAFT_UPSTREAM=http://127.0.0.1:8765 ../atelier_web/run.sh
```

`trunk build --release` needs the `wasm32-unknown-unknown` target and downloads the matching
`wasm-bindgen-cli` and `wasm-opt` by itself.

Two builds of the same source are byte-identical, but editing a *comment* still changes the wasm,
because source line numbers are embedded for panic locations. Comparing hashes after a comment-only
edit is therefore not a way to prove the build did not change; comparing the patch's code lines is.

## When upstream moves

The patch is written against `e26442657f39d04716656baf749d3268ee3f8a0f` (`v0.7.0-150-ge2644265`), the
commit the outer repository pins. Drift shows up as `apply.sh check` failing against a newer ref,
almost always in the `file_dialog` closure in `services()`, which is where every hunk but `main.rs`
lands. Checked on 2026-10-12, it also applies cleanly to upstream `main` (`dac995e`, 26 commits on:
one added line in the neighbouring `export` closure) with a 3-way merge. A 3-way merge needs the pinned
ref in the object database, so fetch it first when the checkout is a shallow clone of another branch:

```sh
git -C /tmp/photocraft-hook fetch --depth 1 origin e26442657f39d04716656baf749d3268ee3f8a0f
```

Re-apply by hand when upstream moves inside a hunk, and regenerate:

```sh
git -C /tmp/photocraft-hook diff > hook/atelier_web.patch
```
