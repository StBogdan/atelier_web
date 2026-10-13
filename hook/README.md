# The PhotoCraft patch

One new file and five hunks, applied to a PhotoCraft checkout. This is the only place the patch is
documented. The design says why it exists ([The PhotoCraft Patch](../../docs/atelier_web_design.md#the-photocraft-patch), [Keeping the Patch Re-appliable](../../docs/atelier_web_design.md#keeping-the-patch-re-appliable));
everything operational is here, next to the file.

```
atelier_web.patch          the patch, a `git diff` against the recorded upstream ref
apply.sh                   apply / check / revert / build it against any ref
```

## What it touches

| File | Change |
|---|---|
| `apps/photocraft-web/src/atelier_cloud.rs` | new: the whole cloudspace hook, and the link's label and URL |
| `apps/photocraft-web/src/main.rs` | one line: `mod atelier_cloud;` |
| `apps/photocraft-web/src/web.rs` | `services()`: `file_dialog` and `write` route through the module, plus `home_link` |
| `apps/photocraft-web/Cargo.toml` | the `web-sys` features the OPFS bindings need |
| `crates/ui-egui/src/lib.rs` | one `Services` field: `home_link` |
| `crates/ui-egui/src/panels.rs` | the title bar draws it to the left of its Discord link |

The `Cargo.toml` hunk has to be there: `FileSystemDirectoryHandle`, `FileSystemFileHandle` and
`FileSystemWritableFileStream` are the bindings design [Keeping the Patch Re-appliable](../../docs/atelier_web_design.md#keeping-the-patch-re-appliable) names, and none of
them is switched on for the web runner today. Features are not dependencies, so nothing is added to the
wasm dependency graph.

The two `crates/ui-egui` hunks are the patch's only footprint outside the web runner, and they are
deliberate: one `Services` field carrying a label and a URL, and the title bar drawing it. Take them out
and the way back to the workspace is a link floating over the canvas rather than part of the app.
Everything else upstream (engine, format, `crates/io`, the `Services` trait) is untouched.

The patch speaks only the contract names in `../contract/protocol.md`, never provider internals, so a
provider release cannot force a patch release.

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

- **Selection stays the provider's job.** `File ▸ Open` re-opens the bound project's document when the
  page is bound and that document exists. Everywhere else it is the browser's picker, which is how a
  local file gets in and how its save then lands in the project. Drag-and-drop is unchanged.
- **Only document formats stay in the project.** A save to `.pcraft`, `.psd`, `.psb` or `.ora` goes
  to OPFS; Export As (PNG, JPEG, TIFF, TGA, WebP) still downloads, as it did.
- **The write is asynchronous.** OPFS cannot be written synchronously from the main thread and the
  editor's `Services::write` is synchronous, so the module schedules the write and reports success.
  What actually happened to the file is the provider's to derive from the filesystem (design [File Ownership](../../docs/atelier_web_design.md#file-ownership)).

The save follows the [Saving](../../docs/atelier_web_design.md#saving) sequence: exclusive Web Lock, `.prev` beside the document, `tmp/<uuid>`
staging, then the document. `FileSystemWritableFileStream::close()` swaps the finished file in, so
the document is never seen half-written. The bytes handed to `write()` are a `Uint8Array` with a buffer
of its own, never a Rust slice: WebKit's `write()` writes the whole backing buffer of a view, so a slice
of the wasm heap would put the heap, not the document, in the file.

Which dialogs it claims:

| Request | Claimed when | Otherwise |
|---|---|---|
| `File ▸ Open` (several files, no extension filter) | a project with a document is bound | the browser's picker, unchanged |
| `Save`/`Save As` suggesting `.pcraft`, `.psd`, `.psb` or `.ora` | a project is bound | the download name, unchanged |
| Export As (PNG, JPEG, TIFF, TGA, WebP) | never | downloads, unchanged |
| Place, scripts, presets (the request carries extensions) | never | unchanged |

Those two tests are all of it: `File ▸ Open` asks for several files and a command reading one file does
not, and an export suggests a flat format. In a bound session that holds a document, `File ▸ Open`
reopens it, which makes it the way back to the file on disk. In a workspace with no document yet the
request is not claimed, the editor's own picker opens, and the save that follows lands in the project.

## Code-wise

- **No new crates.** OPFS is `web-sys`: `FileSystemDirectoryHandle`, `FileSystemFileHandle`,
  `FileSystemWritableFileStream`. Those features are the whole `Cargo.toml` hunk, so the wasm dependency
  graph is unchanged. The release build is 23,943,791 bytes, inside Cloudflare's 25 MiB per-file cap.
- **`js_sys::Reflect` for two APIs.** `navigator.locks.request` and `BroadcastChannel` go through
  `Reflect`, because the typed `LockManager` bindings sit behind `web_sys_unstable_apis`, a cfg this build
  does not set.
- **One `thread_local!` binding** holds `{ project, document }`, set once from `services()`. The app's own
  state is untouched: no new `Services` field beyond `home_link`, no new trait method, no format change.
- **One synthetic event.** eframe paints when something asks it to, so after the launch read the module
  dispatches `popstate` on the window, which the web runner repaints on. Without it the document waits for
  the next mouse move.
- **It speaks the contract only:** `provider.json`, `projects/`, `tmp/`, the lock
  `atelier-cloud:project:<id>`, the channel `atelier-cloud`. No provider internals, so a provider release
  cannot force a patch release.

## Using it

To run the patched editor, you rarely need this script: `../../run.sh` at the repository root does the
worktree, the build and the server for you, and starts Atelier web pointed at it. This script is for
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

Then serve the patched build and point Atelier web at it, so the editor and Atelier Cloud still
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

The patch is written against `d43db3e153c76aefce9b32cef9099e458eaf17a8` (`v0.8.2`), the
commit the outer repository pins. Drift shows up as `apply.sh check` failing against a newer ref,
almost always in the `file_dialog` closure in `services()`, which is where every hunk but `main.rs`
lands. Checked on 2026-10-13, it applies cleanly to upstream `main` (`6f850542`, 286 commits on) with a
3-way merge. Coming off the previous pin (`v0.7.0-150-ge2644265`) needed more than a 3-way merge:
upstream had added the `FileDialogRequest::Folder` arm inside that closure and made the enum
exhaustive, so the module's `answer()` grew a wildcard arm to go with `claims()`'s. A 3-way merge needs
the pinned ref in the object database, so fetch it first when the checkout is a shallow clone of
another branch:

```sh
git -C /tmp/photocraft-hook fetch --depth 1 origin d43db3e153c76aefce9b32cef9099e458eaf17a8
```

Re-apply by hand when upstream moves inside a hunk. `git diff` skips an untracked file, so `git add -N`
the new module first, and regenerate:

```sh
git -C /tmp/photocraft-hook add -N apps/photocraft-web/src/atelier_cloud.rs
git -C /tmp/photocraft-hook diff > hook/atelier_web.patch
```

A container is the wrong target for any of this: the patch is a source change, so an image built from
upstream behaves as if it did not exist. Build one from a patched checkout if you need a container.

## What is not in it

Realtime co-editing, revisions, sync, the tool runtime, and any file browser. The editor is told about one
document and returns bytes (design [Selection](../../docs/atelier_web_design.md#selection), [Out of Scope for v1](../../docs/atelier_web_design.md#out-of-scope-for-v1)).
