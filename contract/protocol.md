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
| Atelier Cloud (provider) | everything below it | everything except the documents, which it replaces whole in the cases in [Documents](#documents), or removes |
| The editor (the patch) | `provider.json`, `projects/<id>/` | `<name>.pcraft` and its `.prev` |

## Layout

```
<OPFS root>/
└── atelier-cloud/
    ├── provider.json                 {"protocol":1,…}: what the consumer reads first
    ├── index/workspaces.json         the catalog the landing page renders
    ├── projects/<id>/
    │   ├── meta.json                 identity, revision and sync state
    │   ├── bucket.json               the bucket this workspace is attached to — never a credential
    │   ├── <name>                     the documents: what a workspace was started from and what the
    │   │                             editor saved into it — any format, `.pcraft` to record versions
    │   ├── <name>.prev                the previous bytes, beside it during a swap
    │   └── thumb.png                 preview for the landing page
    ├── outbox/<id>/pending.json      the change the provider has not committed yet
    └── tmp/<uuid>                    write staging (transient; either side may leave a file behind)
```

`objects/` and `ipc/` are reserved directory names, not part of protocol 1: `objects/` for the local object
mirror that arrives with the server ([Delta Sync](../../docs/atelier_web_design.md#delta-sync)), `ipc/` for asking a
running editor to open another document. Nothing writes either, and a consumer must not depend on them.

`provider.json` and `index/` are created by the provider on first use. `projects/` and `tmp/` are
created with them; `outbox/<id>/` is created when a project has an uncommitted change, and
`bucket.json` when a workspace is given a bucket.

A project holds one or more documents, all in its one directory. Nothing nests below `projects/<id>/`:
what a browser of a workspace shows is a list of file names, not a tree.

### provider.json

```json
{"protocol":1,"name":"Atelier Cloud"}
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
diff exact without re-reading the previous bytes (design [Delta Sync](../../docs/atelier_web_design.md#delta-sync), [Where Cloud State Is Surfaced](../../docs/atelier_web_design.md#where-cloud-state-is-surfaced)).

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

`dirty` and the revision are the provider's derivation, never written by the editor (design [File Ownership](../../docs/atelier_web_design.md#file-ownership)).
`revision.modified` is the document's `File.lastModified` as of the commit, so a card can tell
"changed" from "unchanged" with one `stat` instead of a hash.

`sync.remote` is where the bucket copy is recorded, and is absent until there is one: `key` (the logical
key the document is stored under), `hash` (`sha256:<hex>` of the bytes that were uploaded), `size`, `at`,
and `etag` from the bucket when its CORS policy exposes one. It is additive to protocol 1
([Versioning](#versioning)): a consumer that does not know it ignores it, and it says nothing about
revisions — the bucket holds documents, not history.

```json
"sync": {
  "state": "local",
  "at": "2026-10-12T08:30:58.001Z",
  "remote": {
    "key": "8f14e45f-ceea-4a4d-9b8e-1a24a1f0d3c7/doc.pcraft",
    "hash": "sha256:41ab…",
    "size": 179714,
    "at": "2026-10-12T09:02:11.004Z",
    "etag": "\"ee3e0e8451b950506adc15a32aa23fb2\""
  }
}
```

### projects/&lt;id&gt;/bucket.json

The bucket this workspace was given, and nothing that could be used to sign for it. A user attaches a
bucket to one workspace, and the whole request is signed in that browser
(design [The Bucket Credential](../../docs/atelier_web_design.md#the-bucket-credential)).

```json
{
  "protocol": 1,
  "endpoint": "https://ACCOUNT_ID.r2.cloudflarestorage.com",
  "bucket": "atelier-development",
  "region": "auto",
  "prefix": "atelier/",
  "accessKeyId": "…",
  "urlTtlSeconds": 900,
  "attachedAt": "2026-10-12T09:41:00.112Z"
}
```

| Field | Meaning |
|---|---|
| `endpoint` | The bucket's S3 API endpoint, as attached and normalised: `scheme://host`, plus any base path. |
| `bucket` | The bucket to presign for. |
| `region` | The region in the signature. R2's is `auto`. |
| `prefix` | Empty, or a validated key ending in `/`, joined onto every key this workspace writes. A shared bucket needs one. |
| `accessKeyId` | The key id, which is an identifier and not a secret: SigV4 puts it in the credential scope of every URL. |
| `urlTtlSeconds` | The lifetime of a signed URL, 1 to 604800. |
| `attachedAt` | When the attachment was made. |

There is deliberately no secret field. The private half of the pair is held as a non-extractable
`CryptoKey` in this origin's IndexedDB — a `CryptoKey` is not bytes, so it cannot live in OPFS — and the app
never holds the raw secret once the attach form has been submitted. What that does and does not protect is
the design's subject ([The Bucket Credential](../../docs/atelier_web_design.md#the-bucket-credential)); the
point here is only that this file is not where the credential is. The key is written before this file, so a
`bucket.json` that exists without a key means that store was cleared under it; re-attaching is what restores
signing, and it costs the attachment, never the bucket.

`bucket.json` is where the document goes; `sync.remote` in `meta.json` is what happened the last time
it went there. Detaching removes this file and the key with it, and leaves both the document here and
the copy in the bucket alone.

### Documents

The files directly in `projects/<id>/`, beside `tmp/<uuid>` staging. A document is any file there that
is not Atelier web's own (`meta.json`, `bucket.json`, `thumb.png`) and not a one-save-back shadow
(`<name>.prev`), so a project's documents are what a workspace was started from and what the editor has
saved into it. They are flat: a browser of a workspace lists file names, not a tree.

`.pcraft` is the editor's own single-file ZIP — the bytes it produces and consumes — and the only format
a revision can describe, because `revision.objects`, the diff and the thumbnail all come out of that ZIP.
`meta.json` therefore records the one `.pcraft` its revision describes, in `document`; a document of any
other format is held without one, and `commit` refuses with that reason rather than recording an empty
object set. `<name>` is the editor's own document name, so it round-trips into the editor's title bar.

A consumer that wants "the project's document" takes `document` when it is there, else the first
`*.pcraft` in name order, else the first file — so a project with several, or with a format that is not
`.pcraft`, is additive to protocol 1 rather than a break in it.

The editor's reach from a workspace follows the same rule: a document it opens from here is a `.pcraft`.
Its own file picker reads every format it can read from the reader's computer, and saving into a project
writes one as a `.pcraft` (design, Selection).

**A document opened into a bound editor session is written as it opens**, not on its first save
(design, Import on Open): the reader picked a file from their own computer, and leaving it out of the
workspace until a Save would let a workspace look emptier than the editor makes it look. It is written
under its own name — the extension it arrived with, `.pcraft` when it had none — and the tab that opens
is bound to that file, so the Save that follows writes it rather than a second copy of it.

The provider writes a document in exactly two cases, always as a whole-document replace under
`atelier-cloud:project:<id>` in `exclusive` mode, so no reader can catch it half-written:

| Case | From |
|---|---|
| *Discard* on a workspace | the editor's `<name>.pcraft.prev`, one save back |
| *Download from bucket* | the object store, at `sync.remote.key` |

It renames one in exactly one case: *Rename* on a document row, which keeps the document and its
one-save-back copy and gives them the new name. OPFS has no `move()` every browser has, so that is a
read, a write and a remove under the same exclusive lock. A name already used in the project is
refused rather than written over, and a recorded bucket copy is forgotten with it: `sync.remote.key`
names the document the object was uploaded as, and object storage has no rename.

It removes one in exactly one case: *Delete* on a document row, which takes the same exclusive lock and
removes `<name>.pcraft` and its `.prev`. The copy in the bucket is deliberately left where it is —
it may be the only one off this machine — and the project goes back to uncommitted when the deleted
document was the one the revision described.

The revision is kept honest in both cases: a rename carries the name in `meta.json` with it, and
deleting the document the revision described clears that record, so the project is uncommitted again
rather than naming a file that is gone. Neither blocks the editor's save — it takes the same lock and
writes over it.

### outbox/&lt;id&gt;/pending.json

The one thing in OPFS that is not yet safe anywhere else (design [Design Rules](../../docs/atelier_web_design.md#design-rules)). Written when the provider
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
  "added": 41,
  "changed": 0,
  "removed": 2,
  "bytes": 19298016,
  "unchanged": 812,
  "unchangedBytes": 157286400
}
```

## Coordination

One writer per project, per the design's [Coordination Primitives](../../docs/atelier_web_design.md#coordination-primitives) table. Locks are per origin, like OPFS, and survive
tabs and reloads.

| Lock | Mode | Holder |
|---|---|---|
| `atelier-cloud:project:<id>` | `exclusive` | the editor's save; the provider's scan of the document and its commit |
| `atelier-cloud:project:<id>` | `shared` | the provider's read of the document (a diff), the editor's read at open |

A shared request is granted alongside other shared requests and never while an exclusive one is
pending or held, so a read can never catch a swap half-finished (design [Saving](../../docs/atelier_web_design.md#saving)).

Signalling is `BroadcastChannel("atelier-cloud")`. Every message is advisory: OPFS state is the
truth, and a consumer reconciles from it on focus or on a timer whatever the channel said. The
provider may miss a message because the editor tab slept; the editor must not assume anyone heard it.

| Message | From | Meaning |
|---|---|---|
| `{"type":"document-saved","project":…,"document":…,"bytes":…,"at":…}` | the editor | a project's document changed; re-scan it now instead of on the next focus |

`ipc/open.json` (`{"protocol":1,"project":"<id>"}`) is the reserved name for asking an editor that is
already running to open another document: the provider writes it and pings the channel. Nothing writes it:
opening a workspace is a navigation to `/?project=<id>`, and a page serves one project.

## Identifiers

A project id is `crypto.randomUUID()`: `[0-9a-f-]`, 36 characters. It reaches a page inside a query
parameter that needs no escaping, and a consumer that reads ids from the URL may reject anything
outside `[A-Za-z0-9_-]{1,64}` without further parsing. A document name is a file name inside the
project directory: no `/`, no leading `.`, and it ends in `.pcraft`.

## Versioning

`protocol` is an integer, raised when a change would break an existing consumer, and it appears in
`provider.json`, in the catalog, and in `meta.json`. Additive fields do not raise it: a consumer
ignores what it does not know, and the provider keeps its own state in its own files. The editor
patch refuses to open anything whose `protocol` it does not speak (design [Keeping the Patch Re-appliable](../../docs/atelier_web_design.md#keeping-the-patch-re-appliable)).

`bucket.json` is additive in exactly this sense: a consumer that has never heard of it reads
`meta.json` and the document and is unaffected, and it says nothing about revisions — a bucket holds
documents, not history.

## What is deliberately not here

- No listing API, no browsing, no "open recent". Selection is the provider's to render, and what it
  hands over is named: the document, or the documents, the user chose (design [Selection](../../docs/atelier_web_design.md#selection)).
- No provider API in the filesystem: no request queue, no job file, no state the provider must poll.
  The provider derives what it needs from `meta.json` and the document.
- No lock file. Web Locks has no leak to clean up after a crashed tab.
- No object extraction in M1. `revision.objects` records names and sizes; copying the entries into
  `objects/` is the M2 mirror, and nothing in M1 depends on it.
