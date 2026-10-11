# Atelier Cloud

The second application of the surround design ([`../atelier_web_design.md`](../atelier_web_design.md)):
the **cloudspace provider** that owns the Origin Private File System (OPFS), and later the sync,
accounts and sharing around the PhotoCraft editor. The editor itself is unmodified — see the design's
patch plan (§11).

**Status: M1 starting point.** This is deliberately elementary: a hello-world page, plus the front
door that puts both apps on one origin. No OPFS contract work, no patch, no server-side accounts yet.

## Layout

```
atelier_web/
├── README.md          this file
├── run.sh             start both apps together (see below)
├── server/            the front door: Rust + axum (the §2.2/§2.3 box, co-located here)
│   ├── Cargo.toml
│   └── src/main.rs
├── web/               Atelier Cloud itself — currently one hello-world page
│   └── index.html
└── file_samples/      three PSD/PSB files to open in the editor
```

## Running the thing

One command, from this directory:

```sh
./run.sh
```

Then open **<http://127.0.0.1:3000/cloud/>**.

That gives you both apps on one origin:

| URL | What |
|---|---|
| <http://127.0.0.1:3000/cloud/> | Atelier Cloud (the hello-world page, plus an OPFS storage report) |
| <http://127.0.0.1:3000/> | PhotoCraft, the editor |
| <http://127.0.0.1:3000/api/health> | `{"service":"atelier-web","status":"ok","hello":"world"}` |

`run.sh` starts the editor container if it is stopped, waits for it to be healthy, then runs the front
door in the foreground. Ctrl-C stops the front door; the container keeps running.

### Do not open the editor's port directly

Everything must be reached through **:3000**. OPFS is keyed by *origin* (`scheme://host:port`), so
<http://127.0.0.1:8080/> is a **different origin with a different, empty OPFS** — the two apps then
cannot see each other's data, and nothing reports an error (design §1, §2.3). The front door exists
precisely to prevent this.

### If you have no container yet

`run.sh` says so and stops. Build the editor once (needs Colima/Docker running):

```sh
cd ../photocraft
docker build --load -t photocraft-web:local .
docker run -d --name photocraft-web --restart unless-stopped -p 8080:8080 photocraft-web:local
```

### Or run the editor from source

Useful while changing the editor, since you keep `trunk serve`'s autoreload:

```sh
# terminal 1 — the editor on :8765
cd ../photocraft/apps/photocraft-web && trunk serve

# terminal 2 — the front door, pointed at it
cd ../atelier_web && PHOTOCRAFT_UPSTREAM=http://127.0.0.1:8765 ./run.sh
```

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ATELIER_PORT` | `3000` | Port the front door listens on (loopback only). |
| `PHOTOCRAFT_UPSTREAM` | `http://127.0.0.1:8080` | Where the editor is served from. |
| `ATELIER_WEB_DIR` | `web/` | Directory served at `/cloud/`. |

Plain `http://` upstreams only: the proxy is built without TLS support to keep the first build quick
(see `server/Cargo.toml`). Everything runs on loopback, so that is fine; add `rustls-tls` to `reqwest`
if you ever need an `https://` upstream.

## How it works

`server/` is a small [axum](https://github.com/tokio-rs/axum) app with three routes:

- `/api/health` — the hello-world JSON endpoint.
- `/cloud/…` — static files from `web/` (that is this app).
- **everything else** — reverse-proxied to `PHOTOCRAFT_UPSTREAM`, so the editor is on our origin.

Requests and responses are forwarded with hop-by-hop headers stripped and `Host` re-derived, so the
editor's `application/wasm` MIME type and its precompressed gzip assets keep working untouched. If the
editor is not running, `/` returns a 503 page that says how to start it instead of a bare error —
that is the most common state during development.

Later (design §9) this same process grows into the real service: accounts, projects, revisions and the
tool registry. It is the front-door box of design §2.2/§2.3, not a throwaway dev tool.

## Repositories

This directory is **its own git repository** (`main`), because the design keeps the provider developed
separately from the editor. The surrounding tree is a second repo that holds the design and pins
`photocraft` as a submodule — see [`../project_status.md`](../project_status.md) for the
layout and for how this becomes a submodule too once it has a remote.

## `file_samples/`

Three samples, so there is something to open in the editor before the cloud flow exists. Each covers a
different code path, and all three load with the editor's own importer (verified):

| File | What it exercises |
|---|---|
| `01-rgb-layered.psd` | the common case — 300×200 RGB, 8-bit, 3 pixel layers |
| `02-layer-groups.psd` | layer structure — 300×200 RGB, 8-bit, one group |
| `03-psb.psb` | the PSB (version 2) reader — 413×413 RGB, 8-bit |

To open one, drag it onto the editor at <http://127.0.0.1:3000/>. To inspect one from the terminal:

```sh
../photocraft/target/release/photocraft-cli info file_samples/01-rgb-layered.psd
```

They come from [ag-psd](https://github.com/Agamnentzar/ag-psd) (MIT; licence alongside). That project and
[psd-tools](https://github.com/psd-tools/psd-tools) also back the editor's own **pinned corpus** — 170
files covering every colour mode (RGB, CMYK, Lab, grayscale, indexed, bitmap, duotone, multichannel),
depths 1/8/16/32-bit, PSD and PSB, one file per blend mode and adjustment, plus masks, text, vectors,
smart objects and artboards, all sha256-verified at a pinned commit:

```sh
cd ../photocraft && cargo xtask corpus --psd    # → corpus/psd/
```

That corpus is gitignored and not committed anywhere by convention, so it stays outside this folder.
Reach for it when you need a broad format matrix; these three exist only so there is something to open.

## What is next (design §14, M1)

1. The OPFS contract (§3): `provider.json`, `projects/`, the workspace catalog, Web Locks.
2. The landing page (§6): workspace grid, launch, storage health — replacing this hello-world page.
3. The editor patch (§11): one new file plus three small hunks, so `/cloud/` can hand a document to the
   editor and receive it back.
