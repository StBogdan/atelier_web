# Atelier Cloud

The second application of the surround design ([`../docs/atelier_web_design.md`](../docs/atelier_web_design.md)):
the **cloudspace provider** that owns the Origin Private File System (OPFS), and later the sync, accounts
and sharing around the PhotoCraft editor. The editor itself is unmodified, bar a small patch we re-apply
(design [The PhotoCraft Patch](../docs/atelier_web_design.md#the-photocraft-patch)).

**Status: M1 complete, and the bucket end of M2 begun.** A workspace can be created, opened in the
editor, edited, saved back into OPFS, and seen in the Changes panel as an exact object diff. A workspace
can also be given a bucket of its own, and its document uploaded and downloaded from the browser. There
are still no accounts and no server-side revisions, and the only thing that ever holds a bucket
credential is the browser it was given to.

## Layout

```
atelier_web/
├── README.md          this file
├── run.sh             start both apps together (see below)
├── server/            Atelier web: one process, both apps, one origin (design, The One-Origin Development Setup)
│   ├── Cargo.toml
│   └── src/
│       └── main.rs    the routes: health, the cloud app, the editor proxy
├── web/               Atelier Cloud: SvelteKit, static, SSR off (design, The Landing Page and Launcher)
│   ├── src/lib/       the OPFS contract, the .pcraft reader, the pages' shared state, the bucket
│   ├── src/routes/    /, /workspace/<id>, /settings, /help
│   ├── static/samples three converted documents to seed a workspace with
│   └── build/         what Atelier web serves (gitignored)
├── contract/          the versioned OPFS contract (design, OPFS Layout & Handoff)
│   └── protocol.md
├── hook/              the only thing applied to photocraft (design, The PhotoCraft Patch)
│   ├── atelier_web.patch
│   ├── apply.sh
│   └── README.md
├── test/              the browser walkthroughs, and a local S3 stand-in for the bucket one
│   ├── walkthrough.mjs
│   ├── attach.mjs
│   └── s3-stub.mjs
└── file_samples/      the PSD/PSB originals, and to-pcraft.sh
```

## Running the thing

From the repository above this one, `./run.sh` builds everything and serves both apps:

```sh
cd .. && ./run.sh                 # then open http://127.0.0.1:3000/cloud/
```

Inside this directory, the two steps are separate. Build the cloud app once, then start it with whatever
editor you have:

```sh
cd web && npm install && npm run build && cd ..
./run.sh                                  # with the container's editor
PHOTOCRAFT_UPSTREAM=http://127.0.0.1:8765 ./run.sh    # with a patched build you serve yourself
```

Neither needs a bucket, and neither is configured with one: a bucket is attached to a *workspace*, in the
workspace page's Bucket panel, with the user's own credential ([The bucket](#the-bucket)).

Then open **<http://127.0.0.1:3000/cloud/>**.

| URL | What |
| --- | --- |
| <http://127.0.0.1:3000/cloud/> | Atelier Cloud: the workspace grid and storage health |
| <http://127.0.0.1:3000/cloud/workspace/&lt;id&gt; | one workspace: the Changes panel, commit, download, discard, and the bucket |
| <http://127.0.0.1:3000/cloud/settings> | storage, persistence, and what the cloudspace holds |
| <http://127.0.0.1:3000/cloud/help> | FAQ and troubleshooting: bucket setup, CORS, and the errors that read like credentials |
| <http://127.0.0.1:3000/> | PhotoCraft, the editor; launched into a workspace its title bar links back to it |
| <http://127.0.0.1:3000/api/health> | `{"service":"atelier-web","status":"ok","hello":"world"}` |

`run.sh` starts the editor container if it is stopped, waits for the editor to answer, then runs Atelier web
in the foreground. Ctrl-C stops Atelier web; the container keeps running. It also says what to build when
something is missing, so running it cold is safe.

That editor is the container's, which is unpatched. It opens and edits files from your own disk, and it
has no idea a cloudspace exists. To open a workspace, edit and save back, use the patched build:
"Running the editor from the patched source" below is the same `./run.sh` with `PHOTOCRAFT_UPSTREAM`
pointed at it, and that is how the flow in "Opening a workspace" is reached.

`/cloud/` is a static SPA, so Atelier web serves one `index.html` for every route under it. That is why
`/cloud/settings` and `/cloud/workspace/<id>` work with no server behind them.

### Do not open the editor's port directly

Everything must be reached through **:3000**. OPFS is keyed by *origin* (`scheme://host:port`), so
<http://127.0.0.1:8080/> is a different origin with a different, empty OPFS, so the two apps cannot see each
other's data, and nothing reports an error (design [OPFS](../docs/atelier_web_design.md#opfs), [The One-Origin
Development Setup](../docs/atelier_web_design.md#the-one-origin-development-setup)). Atelier web exists
precisely to prevent this.

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

To exercise the cloud flow end to end, build the patched editor and point Atelier web at it (design [The
PhotoCraft Patch](../docs/atelier_web_design.md#the-photocraft-patch), [Keeping the Patch Re-
appliable](../docs/atelier_web_design.md#keeping-the-patch-re-appliable)):

```sh
cd ../photocraft
git worktree add --detach /tmp/photocraft-hook d43db3e153c76aefce9b32cef9099e458eaf17a8
cd ../atelier_web
CARGO_TARGET_DIR=../photocraft/target PHOTOCRAFT_DIR=/tmp/photocraft-hook ./hook/apply.sh build
cd /tmp/photocraft-hook/dist/web && python3 -m http.server 8765
cd - && PHOTOCRAFT_UPSTREAM=http://127.0.0.1:8765 ./run.sh
```

Keep the worktree out of `../photocraft` itself: the pinned submodule is upstream and stays pristine.
[`hook/README.md`](hook/README.md) has the details, including how to re-apply once upstream moves.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `ATELIER_PORT` | `3000` | Port Atelier web listens on (loopback only). |
| `PHOTOCRAFT_UPSTREAM` | `http://127.0.0.1:8080` | Where the editor is served from. |
| `ATELIER_WEB_DIR` | `web/build` | Directory served at `/cloud/`. |

That is the whole list. There is no bucket configuration and no credential here at all: a bucket belongs
to a workspace and is attached in the browser ([The bucket](#the-bucket)).

Plain `http://` upstreams only: the proxy is built without TLS support to keep the first build quick
(see `server/Cargo.toml`). Everything runs on loopback, so that is fine; add `rustls-tls` to `reqwest`
if you ever need an `https://` upstream. The bucket is a different connection entirely — the browser
speaks HTTPS to it, and this process is not in the path.

### CORS on the bucket

The browser is a cross-origin client of the bucket: it signs the request itself and sends the bytes
itself, so nothing about the exchange passes through Atelier web (design [Object
Storage](../docs/atelier_web_design.md#object-storage)). That means the bucket has to allow this origin, or
the upload fails with an opaque error that reads like bad credentials
(`../docs/further_considerations.md`, Bucket CORS).

Cloudflare R2, **Settings ▸ CORS Policy** on the bucket — the origin is wherever Atelier web is served
from:

```json
[
  {
    "AllowedOrigins": ["http://127.0.0.1:3000"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

`ETag` has to be exposed for the cloud app to record it beside the upload; without that the upload still
works and the record simply has no ETag. It is per origin, and per bucket: whoever attaches a bucket
needs this on it, and a production origin belongs in `AllowedOrigins` alongside the development one.

## How it works

`server/` is the **Atelier web**: one small [axum](https://github.com/tokio-rs/axum) process that both apps
are reached through, on one port. It is the reason they share an origin — and therefore one OPFS (design [The
One-Origin Development Setup](../docs/atelier_web_design.md#the-one-origin-development-setup)) — and it holds
no credential of any kind. It is three routes:

- `/api/health` — the hello-world JSON endpoint.
- `/cloud/…` — the built SvelteKit app, falling back to its `index.html` for client routes.
- everything else, reverse-proxied to `PHOTOCRAFT_UPSTREAM`, so the editor is on our origin.

Requests and responses are forwarded with hop-by-hop headers stripped and `Host` re-derived, so the
editor's `application/wasm` MIME type and its precompressed gzip assets keep working untouched. If the
editor is not running, `/` returns a 503 page that says how to start it instead of a bare error.

The cloud app talks to OPFS, to this origin's own files, and — only when asked — to the bucket.
[`contract/protocol.md`](contract/protocol.md) is the contract: what lives where, which side writes which
file, the lock names, and which messages are advisory only. The short version:

| Side | Owns |
|---|---|
| Atelier Cloud | everything under `atelier-cloud/` except the document: `provider.json`, the catalog, `meta.json`, `bucket.json`, `thumb.png`, `outbox/` |
| The editor patch | `projects/<id>/<name>.pcraft` and its `.prev`, and nothing else |

`web/src/lib/contract.ts` is the provider's side of that, and `web/src/lib/pcraft.ts` reads a `.pcraft`'s
central directory (a STORE-mode ZIP whose entry names are BLAKE3 hashes). That is what makes the Changes
panel exact: the delta is a set difference over entry names, so the object counts and byte sums are real
without decompressing anything or uploading a byte.

## Opening a workspace

"Open" navigates to `/?project=<id>`. The patched editor reads `provider.json`, finds the project's single
`*.pcraft`, takes the shared Web Lock, and hands the bytes to its own import path. File ▸ Save in that
session writes back to `atelier-cloud://<id>/<name>.pcraft`, which the patch turns into the write sequence
of design [Saving](../docs/atelier_web_design.md#saving).

The nav's *Editor* link carries the same `?project=<id>`, for the workspace that changed most recently, so
it lands in the editor with something to show and a *Back to Atelier Cloud* link in the title bar, to
the left of Discord. Opening `:3000/` without a project is the bare editor: no document, no link.

A first workspace needs a document, and a browser cannot convert a PSD, so three `.pcraft` documents are
committed under `web/static/samples/`. They are generated from `file_samples/` with the editor's own
headless CLI, and the landing page offers them, an empty workspace, or a `.pcraft` from your computer:

```sh
cd file_samples && ./to-pcraft.sh          # needs ../photocraft/target/release/photocraft-cli
```

## The bucket

A workspace can be given a bucket of its own: the *Bucket* panel on the workspace page takes an endpoint, a
bucket, a region, a key prefix and an access key pair. The key it writes is `<prefix><project>/<document>`,
and nothing about it is recorded on the server — the workspace's own `bucket.json` says where the document
goes, and `meta.json`'s `sync.remote` (key, hash, size, time, ETag) says what happened the last time it
went there, so a reload, a second tab and an evicted store all agree on what the bucket holds.

**The credential stays in that browser.** It is imported as a non-extractable `CryptoKey` and kept in this
origin's IndexedDB; the app never writes the raw secret down and never sends it anywhere — every request is
signed by the browser that holds it. That is scope and hygiene rather than a wall: it is the CSP, not the
key's non-extractability, that stands between a script on this origin and the bucket (design [The Bucket
Credential](../docs/atelier_web_design.md#the-bucket-credential), and
[`contract/protocol.md`](contract/protocol.md) on what `bucket.json` does and does not hold).

Who does what, in one upload:

1. The cloud app reads `projects/<id>/<name>.pcraft` under the project's shared lock — the same read the
   Changes panel does.
2. It signs a short-lived URL for that key, in the browser (`web/src/lib/sigv4.ts`). Signing is local:
   there is no bucket round trip, and nothing to ask the server.
3. The browser PUTs the bytes straight to the bucket. They never pass through Atelier web, which is what
   keeps R2's free egress meaningful.
4. The cloud app records the result in `meta.json`.

*Download from bucket* is the other direction, and it is a whole-document replace under the project's
exclusive lock, so it asks first: an editor that has the document open will write its own copy back on
its next save. The restored bytes arrive uncommitted, exactly as an edit does, so the Changes panel shows
them and *Record version* is what makes them the revision. This is a provider write to the document
slot, which the contract otherwise keeps to the editor — [`contract/protocol.md`](contract/protocol.md),
File Ownership, records it next to the other one, *Discard*.

*Choose from bucket…* is how a workspace is started from a document that is already in a bucket. It lists
the bucket — one row per `.pcraft`, with the workspace id it sits under — and *Load* puts the one chosen
here, uncommitted, by the same rule as a download. This is the only listing the app makes, and it is a
person's click: nothing local can name a document whose workspace id is not this one. *Download from
bucket* uses the same listing when it has no upload of its own to go by, which is the ordinary case after a
bucket is attached to a workspace that has been going for a while — the bucket says which key is this
workspace's, instead of the app guessing `<id>/<document>` and being wrong. A token therefore needs list
permission as well; R2's *Object Read & Write* has it, and a refusal names the missing permission rather
than the status.

*Detach bucket* removes the attachment file and the key together, and leaves both the document here and
the copy in the bucket alone. *Edit bucket…* reopens the form on the attached bucket; the secret is the one
field it cannot fill in, since it is the one thing never stored in a readable form. When the endpoint is
R2's, the panel also links to the bucket's own page in Cloudflare — the account id is in the endpoint's
host, so nothing extra has to be configured for it.

### What signs, and what checks it

The signature is computed in `web/src/lib/sigv4.ts`: SigV4 in query-string form, a hash chain over the
request, built on WebCrypto's HMAC. It was Atelier web's job until the credential moved to the browser,
and it is not an S3 client either way — a signature is a few dozen lines of hashing, and an S3 client is a
dependency tree, a TLS stack and a C toolchain. That is why Atelier web still cross-compiles with the
single command in [`../deployment_steps.md`](../deployment_steps.md).

`test/s3-stub.mjs` implements the check independently, in Node, and recomputes the signature of every URL
it is handed. Two implementations of one algorithm, on purpose: a presigned URL that is subtly wrong is a
`403` from the provider and says nothing about why.

### Testing it without a bucket

`test/attach.mjs` runs the whole flow in a real Chromium against `test/s3-stub.mjs`, an in-process S3
stand-in. The stub is started with credentials that exist nowhere else — not in an environment, not in a
file — so a signature it accepts is proof that the browser signed with the credential the form was given.
No account, no bucket, nothing persisted, and it asserts the round trip byte for byte.

The app has to be served. Nothing has to be configured for it, and the editor need not be running:

```sh
# terminal 1: Atelier web, with no bucket settings at all
cd server && cargo run --release

# terminal 2
cd test && npm install && npm run attach
```

The script also checks that `/api/storage` is gone and that the page never asks the server about a bucket.
Against a real bucket the panel is the test, and the CORS policy above is what the browser needs.

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

- Accounts, revisions on a server, and sync. "Record version" still records the version locally and
  empties `outbox/`; the bucket is a document copy, not a revision history. The [roadmap](../docs/future/roadmap.md) says what M2 adds.
- Delta upload: the whole document goes up, not the new objects of design [Delta Sync](../docs/atelier_web_design.md#delta-sync), and there is no `objects/` mirror yet.
- Zip export and import (design [Zip Export and Import](../docs/future/zip.md#zip-export-and-import)). "Download files" gives you the raw `.pcraft` instead.
- The tool runtime (design [Tools](../docs/future/tools.md#tools)), sharing, revision history, and topology A's embedded editor.
