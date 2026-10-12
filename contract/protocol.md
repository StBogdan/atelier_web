# The Atelier Cloud OPFS contract

Protocol 1. The stable interface between Atelier Cloud and any app that works inside its cloudspace,
and the only thing the PhotoCraft patch depends on ([`../hook/README.md`](../hook/README.md)).

Two names here are versioned interface, not folder names, and must not be renamed: the OPFS
directory `atelier-cloud/` and the virtual path scheme `atelier-cloud://`. The app folder is
`atelier_web/`.

## What the contract is

OPFS, keyed by origin, is the interface: a shared store, not a message bus. The provider owns
`atelier-cloud/`; a consumer app is *told* about one document, reads it, and writes it back. There is
no file browser in the contract and no provider API: consumers read files, and the provider derives
state from those files.

| Party | Reads | Writes |
|---|---|---|
| Atelier Cloud (provider) | everything below it | everything except the document |
| The editor (the patch) | `provider.json`, `projects/<id>/` | `<name>.pcraft` and its `.prev` |

## Layout

```
<OPFS root>/
└── atelier-cloud/
    ├── provider.json                 {"protocol":1,…}: what the consumer reads first
    ├── index/workspaces.json         the catalog the landing page renders
    ├── projects/<id>/
    │   ├── meta.json                 identity, revision and sync state
    │   ├── <name>.pcraft             the document: the bytes the editor produces and consumes
    │   ├── <name>.pcraft.prev        the previous bytes, beside it during a swap
    │   └── thumb.png                 preview for the landing page
    ├── outbox/<id>/pending.json      the change the provider has not committed yet
    ├── tmp/<uuid>                    write staging (transient; either side may leave a file behind)
    ├── objects/                      the local object mirror — M2, with the server
    └── ipc/open.json                 open request for an already-running editor — not written in M1
```

`provider.json` and `index/` are created by the provider on first use. `projects/` and `tmp/` are
created with them; `outbox/<id>/` is created when a project has an uncommitted change. `objects/` and
`ipc/` exist as contract names only, and neither is written in M1.

### provider.json

```json
{"protocol":1,"name":"Atelier Cloud","capabilities":["open","save","lock","tools"]}
```

The provider creates it if it is missing, and rewrites it if `protocol` does not match. A consumer
that does not understand `protocol` must not touch the rest of the tree.

### index/workspaces.json

A cache of the catalog, regenerable by scanning `projects/`. A consumer may read it to render a list
without scanning; the provider rewrites it after every scan and every change.

```json
{
  "protocol": 1,
  "updatedAt": "2026-10-12T08:31:02.114Z",
  "workspaces": [
    {
      "id": "8f14e45f-ceea-4a4d-9b8e-1a24a1f0d3c7",
      "name": "Autumn Retouch",
      "role": "owner",
      "rev": 3,
      "dirty": false,
      "bytes": 179714,
      "documents": 1,
      "document": "doc.pcraft",
      "updatedAt": "2026-10-12T08:30:58.001Z",
      "thumb": true
    }
  ]
}
```

### projects/&lt;id&gt;/meta.json

The project's identity and the revision it was last committed at. `revision.objects` maps every
content-addressed ZIP entry of the committed document to its size, which is what makes the changes
diff exact without re-reading the previous bytes (design [5.1](../../docs/atelier_web_design.md#51-delta-sync-without-touching-the-editor), [6.5](../../docs/atelier_web_design.md#65-where-cloud-state-is-surfaced-the-provider-and-only-the-provider)).

```json
{
  "protocol": 1,
  "id": "8f14e45f-ceea-4a4d-9b8e-1a24a1f0d3c7",
  "name": "Autumn Retouch",
  "role": "owner",
  "document": "doc.pcraft",
  "createdAt": "2026-10-12T08:30:11.402Z",
  "updatedAt": "2026-10-12T08:30:58.001Z",
  "rev": 3,
  "dirty": false,
  "size": 179714,
  "sync": { "state": "local", "at": "2026-10-12T08:30:58.001Z" },
  "revision": {
    "hash": "sha256:9f2c…",
    "size": 179714,
    "modified": 1760257858001,
    "objects": { "blobs/12db9e….zst": 85, "composite/preview.png": 43669 }
  }
}
```

`dirty` and the revision are the provider's derivation, never written by the editor (design [3.6](../../docs/atelier_web_design.md#36-ownership-who-writes-which-file)).
`revision.modified` is the document's `File.lastModified` as of the commit, so a card can tell
"changed" from "unchanged" with one `stat` instead of a hash.

### The document

`projects/<id>/<name>.pcraft`, the single-file ZIP the editor produces, and `tmp/<uuid>` staging
beside it during a swap. A project holds exactly one `*.pcraft`: that is what a consumer looks for,
and why the editor never needs a file list. `<name>` is the editor's own document name, so it
round-trips into the editor's title bar; the change is a new name in the same slot, not a second
document.

### outbox/&lt;id&gt;/pending.json

The one thing in OPFS that is not yet safe anywhere else (design [4.5](../../docs/atelier_web_design.md#45-the-design-rules-that-follow)). Written when the provider
scans a project whose document differs from its revision.

```json
{
  "protocol": 1,
  "project": "8f14e45f-ceea-4a4d-9b8e-1a24a1f0d3c7",
  "document": "doc.pcraft",
  "rev": 3,
  "hash": "sha256:41ab…",
  "size": 190412,
  "modified": 1760258420442,
  "at": "2026-10-12T08:40:20.447Z",
  "newObjects": 41,
  "newBytes": 19298016,
  "unchangedObjects": 812
}
```

## Coordination

One writer per project, per the design's [3.5](../../docs/atelier_web_design.md#35-coordination-primitives) table. Locks are per origin, like OPFS, and survive
tabs and reloads.

| Lock | Mode | Holder |
|---|---|---|
| `atelier-cloud:project:<id>` | `exclusive` | the editor's save; the provider's scan of the document and its commit |
| `atelier-cloud:project:<id>` | `shared` | the provider's read of the document (a diff), the editor's read at open |

A shared request is granted alongside other shared requests and never while an exclusive one is
pending or held, so a read can never catch a swap half-finished (design [3.4](../../docs/atelier_web_design.md#34-saving)).

Signalling is `BroadcastChannel("atelier-cloud")`. Every message is advisory: OPFS state is the
truth, and a consumer reconciles from it on focus or on a timer whatever the channel said. The
provider may miss a message because the editor tab slept; the editor must not assume anyone heard it.

| Message | From | Meaning |
|---|---|---|
| `{"type":"document-saved","project":…,"document":…,"bytes":…,"at":…}` | the editor | a project's document changed; re-scan it now instead of on the next focus |

`ipc/open.json` (`{"protocol":1,"project":"<id>"}`) is the contract's way to ask an editor that is
already running to open another document: the provider writes it and pings the channel. It is defined
here and not written in M1, where opening a workspace is a navigation to `/?project=<id>` and a page
never serves two projects.

## Identifiers

A project id is `crypto.randomUUID()`: `[0-9a-f-]`, 36 characters. It reaches a page inside a query
parameter that needs no escaping, and a consumer that reads ids from the URL may reject anything
outside `[A-Za-z0-9_-]{1,64}` without further parsing. A document name is a file name inside the
project directory: no `/`, no leading `.`, and it ends in `.pcraft`.

## Versioning

`protocol` is an integer, raised when a change would break an existing consumer, and it appears in
`provider.json`, in the catalog, and in `meta.json`. Additive fields do not raise it: a consumer
ignores what it does not know, and the provider keeps its own state in its own files. The editor
patch refuses to open anything whose `protocol` it does not speak (design [12](../../docs/atelier_web_design.md#12-keeping-the-patch-re-appliable)).

## What is deliberately not here

- No listing, no browsing, no "open recent". Selection is the provider's, and it hands over exactly
  one document (design [3.7](../../docs/atelier_web_design.md#37-selection-what-the-editor-can-and-cannot-see)).
- No provider API in the filesystem: no request queue, no job file, no state the provider must poll.
  The provider derives what it needs from `meta.json` and the document.
- No lock file. Web Locks has no leak to clean up after a crashed tab.
- No object extraction in M1. `revision.objects` records names and sizes; copying the entries into
  `objects/` is the M2 mirror, and nothing in M1 depends on it.
