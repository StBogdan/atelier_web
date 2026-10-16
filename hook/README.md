# The PhotoCraft patch

One new file and six hunks, applied to a PhotoCraft checkout. This is the only place the patch is
documented. The design says why it exists ([The PhotoCraft Patch](../../docs/atelier_web_design.md#the-photocraft-patch), [Keeping the Patch Re-appliable](../../docs/atelier_web_design.md#keeping-the-patch-re-appliable));
everything operational is here, next to the file.

```
atelier_web.patch          the patch, a `git diff` against the recorded upstream ref
apply.sh                   apply / check / revert / build it against any ref
```

## What it touches

| File | Change |
|---|---|
| `apps/photocraft-web/src/atelier_cloud.rs` | new: the whole cloudspace hook — reading a document, saving it back, listing a project's documents, and the link's label and URL |
| `apps/photocraft-web/src/main.rs` | one line: `mod atelier_cloud;` |
| `apps/photocraft-web/src/web.rs` | `services()`: `write` routes through the module, and the `workspace` and `home_link` fields the shell adds |
| `apps/photocraft-web/Cargo.toml` | the `web-sys` features the OPFS bindings need |
| `crates/ui-egui/src/lib.rs` | the `Services` fields and the store's types, and the `Inbox`'s third element: the path a document was read from |
| `crates/ui-egui/src/menus.rs` | `File ▸ Open from Workspace…`: the item the shell's store inserts, labelled by that shell, and the command behind it |
| `crates/ui-egui/src/panels.rs` | the door's window, and the title bar drawing the way back to the left of its Discord link |

The `Cargo.toml` hunk has to be there: `FileSystemDirectoryHandle`, `FileSystemFileHandle` and
`FileSystemWritableFileStream` are the bindings design [Keeping the Patch Re-appliable](../../docs/atelier_web_design.md#keeping-the-patch-re-appliable) names, and none of
them is switched on for the web runner today. Features are not dependencies, so nothing is added to the
wasm dependency graph.

The four `crates/ui-egui` hunks, across three files, are the patch's only footprint outside the web
runner, and they are deliberate: the `Services` fields and the store's types, the File menu item the
shell's store is reached by, and the title bar and the window that draw it. Take them out and the way
back to the workspace is a link floating over the canvas, and opening one of its documents is a page
navigation, rather than part of the app. Everything else upstream (engine, format, `crates/io`, the
`Services` trait) is untouched.

The patch speaks only the contract names in `../contract/protocol.md`, never Atelier web's internals, so
an Atelier web release cannot force a patch release.

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
// The shell's two contributions to the chrome: the store the workspace door lists, and the way back.
workspace: crate::atelier_cloud::workspace_open(inbox.clone()),
home_link: crate::atelier_cloud::home_link(),
```

## What it does

`?project=<id>` binds the page to that project, and `&document=<name>` says which of its documents to
open; without a name the module takes the first `*.pcraft` in name order. It reads
`atelier-cloud/provider.json`, checks the protocol version, reads the document under a shared Web Lock
and hands its bytes to the `Inbox` **together with its `atelier-cloud://<id>/<name>` path**. The app
drains the inbox every frame, so the document opens as a normal one — and because the document carries
its own path, a save writes back to *that* document and not to whichever one the page opened last.

`File ▸ Open` is the local door, and in a bound session the file it picks is written into the project
as it opens (design, Import on Open): the bytes are copied under the file's own name — `.pcraft` when it
had no extension — and the tab that opens carries that path, so nothing is in the editor that is not in
the workspace. A page that is not bound to a project opens the file unbound, exactly as upstream does.

`File ▸ Open from Workspace…` is the second door: it lists the bound project's documents, and the ticked
ones are read the same way, one tab each. A project's documents are a flat list — nothing nests below
`projects/<id>/` — so the window is a list of names and sizes.

Four details worth knowing before changing it:

- **`File ▸ Open` stays the browser's picker.** The patch does not claim it, because the picker is the
  only way a local file gets in and the workspace door exists for the other direction. Drag-and-drop is
  unchanged.
- **The project answers for two saves, by name, and leaves the rest to the shell.** A save asking for a
  name the project already holds is a document going back where it came from, and the answer is that
  document's path. A save asking for a name it does not hold is answered with `<stem>.pcraft` when the
  project holds no document at all — the save that makes its first one. Every other save, and every
  export, is answered the way the shell answers it with no project bound: the file's own name, which
  carries no scheme and so downloads. An export belongs on the reader's disk, and a document saved
  under a name the project does not hold has nowhere in it to go. The one case the dialog cannot tell
  apart is a flat document exported as its own format while the project already holds that name
  (a `photo.png` workspace document exported as PNG): it writes over it.
- **The write is asynchronous.** OPFS cannot be written synchronously from the main thread and the
  editor's `Services::write` is synchronous, so the module schedules the write and reports success.
  What actually happened to the file is Atelier web's to derive from the filesystem (design [File Ownership](../../docs/atelier_web_design.md#file-ownership)).
- **Nothing here knows which document a save is for beyond its path.** The path is the whole binding: a
  `Binding` holds the project, never a document, so several documents can be open at once and a save
  cannot land on the wrong one.

The save follows the [Saving](../../docs/atelier_web_design.md#saving) sequence: exclusive Web Lock, `.prev` beside the document, `tmp/<uuid>`
staging, then the document. `FileSystemWritableFileStream::close()` swaps the finished file in, so
the document is never seen half-written. The bytes handed to `write()` are a `Uint8Array` with a buffer
of its own, never a Rust slice: WebKit's `write()` writes the whole backing buffer of a view, so a slice
of the wasm heap would put the heap, not the document, in the file.

Which dialogs it claims:

| Request | Claimed when | Otherwise |
|---|---|---|
| `File ▸ Open` (several files, no extension filter) | never: this is the local door | the browser's picker, unchanged |
| `Save`/`Save As` of a name the project holds, or of any name when it holds no document | a project is bound | the shell's own answer: the file's name, which downloads |
| Export As, Save for Web, Save a Copy, Quick Export | no: an export belongs on the reader's disk | downloads, unchanged |
| Place, scripts, presets (the request carries extensions) | never | unchanged |

`File ▸ Open` is deliberately *not* claimed — the browser's picker is the only way a local file gets
in, and a workspace's own documents are opened from the workspace door instead, which needs no
dialog. In a workspace that holds no document yet, the picker opens, and the save that follows names the
project's first document.

What the picker hands over is written into the bound project as it opens, not on its first save
(design, Import on Open), so the file is in the workspace and the tab is bound to it. A page that is not
bound to a project opens it the way it always did, unbound and unsaved.

## Code-wise

- **No new crates.** OPFS is `web-sys`: `FileSystemDirectoryHandle`, `FileSystemFileHandle`,
  `FileSystemWritableFileStream`. Those features are the whole `Cargo.toml` hunk, so the wasm dependency
  graph is unchanged, and CI holds the release build to Cloudflare's 25 MiB per-file cap.
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

`build` stamps the build's provenance (`PHOTOCRAFT_BUILD_SHA`, `PHOTOCRAFT_BUILD_DATE`), as upstream's
own `packaging/env.sh` does for a release. Without it the About dialog reports the last *release*
number and "(dev build)", which is misleading: PhotoCraft's version is bumped only at a release, so a
build of the commit before v0.8.2 says `0.7.0 (dev build)` even though it is newer than `v0.7.0`.
Stamped, the same line reads `0.9.0 (c699e3cda, 2026-10-15)` and names what it was built from.

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

The patch is written against `c699e3cda69f4852b43c0b191ab0091aaeff9d6a` (`v0.9.0`), the
commit the outer repository pins. Drift shows up as `apply.sh check` failing against a newer ref.
Checked on 2026-10-15, it applies cleanly to the pin, and it **conflicts** with upstream `main`
(`4e7a17cd`, 175 commits on) in the `crates/ui-egui/src/panels.rs` hunk — the title-bar link cluster,
which grew by 544 lines in those 175 commits. That cluster is the patch's only footprint outside the web
runner, and it is the place upstream churns fastest; the second place to look is the `file_dialog`
closure in `services()`, where every hunk but `main.rs` lands. Coming off the previous pin
(`v0.7.0-150-ge2644265`) that closure was the conflict: upstream had added the
`FileDialogRequest::Folder` arm inside it and made the enum exhaustive, so the module's `answer()` grew
a wildcard arm to go with `claims()`'s. A 3-way merge needs the pinned ref in the object database, so
fetch it first when the checkout is a shallow clone of another branch:

```sh
git -C /tmp/photocraft-hook fetch --depth 1 origin c699e3cda69f4852b43c0b191ab0091aaeff9d6a
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
