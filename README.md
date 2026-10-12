# Atelier Cloud

The second application of the surround design ([`../atelier_web_design.md`](../docs/atelier_web_design.md)):
the **cloudspace provider** that owns the Origin Private File System (OPFS), and later the sync, accounts
and sharing around the PhotoCraft editor. The editor itself is unmodified, bar a small patch we re-apply
(design [11](../docs/atelier_web_design.md#11-the-photocraft-patch)).

**Status: M1 complete.** A workspace can be created, opened in the editor, edited, saved back into OPFS,
and seen in the Changes panel as an exact object diff. There is no server and no account behind it: the
cloud app talks to OPFS and to this origin's own files.

## Layout

```
atelier_web/
├── README.md          this file
├── run.sh             start both apps together (see below)
├── server/            the front door: Rust + axum (design 2.2, 2.3)
│   ├── Cargo.toml
│   └── src/main.rs
├── web/               Atelier Cloud: SvelteKit, static, SSR off (design 6, 16)
│   ├── src/lib/       the OPFS contract, the .pcraft reader, the pages' shared state
│   ├── src/routes/    /, /workspace/<id>, /settings
│   ├── static/samples three converted documents to seed a workspace with
│   └── build/         what the front door serves (gitignored)
├── contract/          the versioned OPFS contract (design 3)
│   └── protocol.md
├── hook/              the only thing applied to photocraft (design 11, 12)
│   ├── atelier_web.patch
│   ├── apply.sh
│   └── README.md
└── file_samples/      the PSD/PSB originals, and to-pcraft.sh
```

## Running the thing

Build the cloud app once, then start both apps:

```sh
cd web && npm install && npm run build && cd ..
./run.sh
```

Then open **<http://127.0.0.1:3000/cloud/>**.

| URL | What |
|---|---|
| <http://127.0.0.1:3000/cloud/> | Atelier Cloud: the workspace grid and storage health |
| <http://127.0.0.1:3000/cloud/workspace/&lt;id&gt; | one workspace: the Changes panel, commit, download, discard |
| <http://127.0.0.1:3000/cloud/settings> | storage, persistence, and what the cloudspace holds |
| <http://127.0.0.1:3000/> | PhotoCraft, the editor |
| <http://127.0.0.1:3000/api/health> | `{"service":"atelier-web","status":"ok","hello":"world"}` |

`run.sh` starts the editor container if it is stopped, waits for the editor to answer, then runs the front
door in the foreground. Ctrl-C stops the front door; the container keeps running.

`/cloud/` is a static SPA, so the front door serves one `index.html` for every route under it. That is why
`/cloud/settings` and `/cloud/workspace/<id>` work with no server behind them.

### Do not open the editor's port directly

Everything must be reached through **:3000**. OPFS is keyed by *origin* (`scheme://host:port`), so
<http://127.0.0.1:8080/> is a different origin with a different, empty OPFS, so the two apps cannot see
each other's data, and nothing reports an error (design [1](../docs/atelier_web_design.md#1-origin-private-file-system-opfs), [2.3](../docs/atelier_web_design.md#23-development-setup-one-origin-or-it-silently-doesnt-work)). The front door exists precisely to
prevent this.

### If you have no container yet

`run.sh` says so and stops. Build the editor once (needs Colima/Docker running):

```sh
cd ../photocraft
docker build --load -t photocraft-web:local .
docker run -d --name photocraft-web --restart unless-stopped -p 8080:8080 photocraft-web:local
```

That container holds an **unpatched** editor: it cannot open a workspace, because the patch is what tells
it about one. `File ▸ Open` there is the local file picker, as it always was.

### Running the editor from the patched source

To exercise the cloud flow end to end, build the patched editor and point the front door at it (design
[11](../docs/atelier_web_design.md#11-the-photocraft-patch), [12](../docs/atelier_web_design.md#12-keeping-the-patch-re-appliable)):

```sh
cd ../photocraft
git worktree add --detach /tmp/photocraft-hook e26442657f39d04716656baf749d3268ee3f8a0f
cd ../atelier_web
CARGO_TARGET_DIR=../photocraft/target PHOTOCRAFT_DIR=/tmp/photocraft-hook ./hook/apply.sh build
cd /tmp/photocraft-hook/dist/web && python3 -m http.server 8765
cd - && PHOTOCRAFT_UPSTREAM=http://127.0.0.1:8765 ./run.sh
```

Keep the worktree out of `../photocraft` itself: the pinned submodule is upstream and stays pristine.
[`hook/README.md`](hook/README.md) has the details, including how to re-apply once upstream moves.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ATELIER_PORT` | `3000` | Port the front door listens on (loopback only). |
| `PHOTOCRAFT_UPSTREAM` | `http://127.0.0.1:8080` | Where the editor is served from. |
| `ATELIER_WEB_DIR` | `web/build` | Directory served at `/cloud/`. |

Plain `http://` upstreams only: the proxy is built without TLS support to keep the first build quick
(see `server/Cargo.toml`). Everything runs on loopback, so that is fine; add `rustls-tls` to `reqwest`
if you ever need an `https://` upstream.

## How it works

`server/` is a small [axum](https://github.com/tokio-rs/axum) app with three routes:

- `/api/health` — the hello-world JSON endpoint.
- `/cloud/…` — the built SvelteKit app, falling back to its `index.html` for client routes.
- everything else, reverse-proxied to `PHOTOCRAFT_UPSTREAM`, so the editor is on our origin.

Requests and responses are forwarded with hop-by-hop headers stripped and `Host` re-derived, so the
editor's `application/wasm` MIME type and its precompressed gzip assets keep working untouched. If the
editor is not running, `/` returns a 503 page that says how to start it instead of a bare error.

The cloud app talks to OPFS and to nothing else. [`contract/protocol.md`](contract/protocol.md) is the
contract: what lives where, which side writes which file, the lock names, and which messages are advisory
only. The short version:

| Side | Owns |
|---|---|
| Atelier Cloud | everything under `atelier-cloud/` except the document: `provider.json`, the catalog, `meta.json`, `thumb.png`, `outbox/` |
| The editor patch | `projects/<id>/<name>.pcraft` and its `.prev`, and nothing else |

`web/src/lib/contract.ts` is the provider's side of that, and `web/src/lib/pcraft.ts` reads a `.pcraft`'s
central directory (a STORE-mode ZIP whose entry names are BLAKE3 hashes). That is what makes the Changes
panel exact: the delta is a set difference over entry names, so the object counts and byte sums are real
without decompressing anything or uploading a byte.

## Opening a workspace

"Open" navigates to `/?project=<id>`. The patched editor reads `provider.json`, finds the project's single
`*.pcraft`, takes the shared Web Lock, and hands the bytes to its own import path. File ▸ Save in that
session writes back to `atelier-cloud://<id>/<name>.pcraft`, which the patch turns into the write sequence
of design [3.4](../docs/atelier_web_design.md#34-saving).

A first workspace needs a document, and a browser cannot convert a PSD, so three `.pcraft` documents are
committed under `web/static/samples/`. They are generated from `file_samples/` with the editor's own
headless CLI, and the landing page offers them, an empty workspace, or a `.pcraft` from your computer:

```sh
cd file_samples && ./to-pcraft.sh          # needs ../photocraft/target/release/photocraft-cli
```

## `file_samples/`

Three samples, so there is something to open before anything has been imported. Each covers a different
code path, and all three load with the editor's own importer (verified):

| File | What it exercises |
|---|---|
| `01-rgb-layered.psd` | the common case: 300×200 RGB, 8-bit, 3 pixel layers |
| `02-layer-groups.psd` | layer structure: 300×200 RGB, 8-bit, one group |
| `03-psb.psb` | the PSB (version 2) reader: 413×413 RGB, 8-bit |

`to-pcraft.sh` converts them into the `.pcraft` documents under `web/static/samples/`, which are what a
new workspace actually starts from. To inspect any of them from the terminal:

```sh
../photocraft/target/release/photocraft-cli info file_samples/02-layer-groups.psd --compact
```

The samples come from [ag-psd](https://github.com/Agamnentzar/ag-psd) (MIT; licence alongside). That
project and [psd-tools](https://github.com/psd-tools/psd-tools) also back the editor's own pinned corpus,
170 files covering every colour mode, depth, blend mode and adjustment, plus masks, text, vectors, smart
objects and artboards:

```sh
cd ../photocraft && cargo xtask corpus --psd    # → corpus/psd/
```

That corpus is gitignored by convention, so it stays outside this folder. Reach for it when you need a
broad format matrix; these three exist so there is something to open.

## What is not here yet

- A server. Nothing is uploaded, there are no accounts and no sync: "Commit revision" records the
  revision locally and empties `outbox/`. Design [14](../docs/atelier_web_design.md#14-milestones) says what M2 adds.
- Zip export and import (design [8](../docs/atelier_web_design.md#8-getting-files-in-and-out-zip-export-and-import)). "Download document" gives you the raw `.pcraft` instead.
- The tool runtime (design [7](../docs/atelier_web_design.md#7-tools-served-by-the-server-executed-in-the-browser)), sharing, revision history, and topology A's embedded editor.

## Repositories

This directory is **its own git repository** (`main`), because the design keeps the provider developed
separately from the editor. The surrounding tree is a second repo that holds the design and pins
`photocraft` as a submodule. See [`../docs/project_status.md`](../docs/project_status.md) for the layout, and for
how this becomes a submodule too once it has a remote.
