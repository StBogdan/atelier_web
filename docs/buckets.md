# Buckets

A workspace can be given a bucket of its own: an S3-compatible bucket, reached with the user's own access key
pair, that the workspace's document is copied to and from. Nothing about the bucket is configured in the
repository or on the server — the workspace's own files say where the document goes, and the browser does the
signing and the transfer.

[`../README.md`](../README.md) is the tour of the app. This is the reference for the bucket half of it.

## Attaching one

The *Bucket* panel on the workspace page takes an endpoint, a bucket, a region, a key prefix and an access key
pair, and the dialog that makes a workspace takes the same fields — so a workspace can be made with a bucket
rather than opened and given one. The key it writes is `<prefix><project>/<document>`, and nothing about it is
recorded on the server: the workspace's own `bucket.json` says where the document goes, and `meta.json`'s
`sync.remote` (key, hash, size, time, ETag) says what happened the last time it went there. A reload, a
second tab and an evicted store therefore agree on what the bucket holds.

**Detach** removes the attachment file and the key together, and leaves both the document here and the copy
in the bucket alone. **Edit bucket…** reopens the form on the attached bucket; the secret is the one field it
cannot fill in, since it is the one thing never stored in a readable form. When the endpoint is R2's, the
panel also links to the bucket's own page in Cloudflare — the account id is in the endpoint's host, so
nothing extra has to be configured for it.

## Upload and download

One upload:

1. The cloud app reads `projects/<id>/<name>.pcraft` under the project's shared lock — the same read the
   Changes panel does.
2. It signs a short-lived URL for that key, in the browser ([`../web/src/lib/sigv4.ts`](../web/src/lib/sigv4.ts)).
   Signing is local: no bucket round trip, nothing to ask the server.
3. The browser PUTs the bytes straight to the bucket. They never pass through Atelier web, which is what
   keeps R2's free egress meaningful.
4. The cloud app records the result in `meta.json`.

**Download** is the other direction, and it is a whole-document replace under the project's exclusive lock,
so it asks first: an editor that has the document open will write its own copy back on its next save. The
restored bytes arrive uncommitted, exactly as an edit does, so the Changes panel shows them and *Record
version* is what makes them the revision. That is a provider write to the document slot, which the contract
otherwise keeps to the editor — [`../contract/protocol.md`](../contract/protocol.md), File Ownership, records
it next to the other one, *Discard*.

## Choose from a bucket

**Choose from bucket…** brings a document a bucket already holds into an existing workspace: it lists the
bucket, one row per object that is not a version shadow or a dotfile, with the workspace id it sits under.
*Load* puts the chosen one here, uncommitted, by the same rule as a download. Any format is offered, because a
workspace holds any file, not only a `.pcraft`. The new-workspace dialog offers the same list under *A cloud
bucket*; it signs with the fields alone, so listing before the workspace exists writes nothing. Listing is
always a person's click and never a guess: nothing local can name a document whose workspace id is not this
one. *Download* uses the same listing when it has no upload of its own to go by, which is the ordinary case
after a bucket is attached to a workspace that has been going for a while — the bucket says which key is this
workspace's, instead of the app guessing `<id>/<document>` and being wrong. A token therefore needs list
permission as well; R2's *Object Read & Write* has it, and a refusal names the missing permission rather than
the status.

## The credential stays in the browser

It is imported as a non-extractable `CryptoKey` and kept in this origin's IndexedDB. The app never writes the
raw secret down and never sends it anywhere: every request is signed by the browser that holds it. That is
scope and hygiene rather than a wall — it is the CSP, not the key's non-extractability, that stands between a
script on this origin and the bucket. [`../contract/protocol.md`](../contract/protocol.md) says what
`bucket.json` does and does not hold.

The signature is SigV4 in query-string form, a hash chain over the request, built on WebCrypto's HMAC. It was
Atelier web's job until the credential moved to the browser, and it is not an S3 client either way: a
signature is a few dozen lines of hashing, and an S3 client is a dependency tree, a TLS stack and a C
toolchain. [`../test/s3-stub.mjs`](../test/s3-stub.mjs) implements the check independently, in Node, and
recomputes the signature of every URL it is handed — two implementations of one algorithm, on purpose,
because a presigned URL that is subtly wrong is a `403` that says nothing about why.

## CORS on the bucket

The browser is a cross-origin client of the bucket: it signs the request itself and sends the bytes itself,
so nothing about the exchange passes through Atelier web. The bucket therefore has to allow this origin, or
the upload fails with an opaque error that reads like bad credentials.

Cloudflare R2, **Settings ▸ CORS Policy** on the bucket — the origin is wherever Atelier web is served from:

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

`ETag` has to be exposed for the cloud app to record it beside the upload; without it the upload still works
and the record simply has no ETag. It is per origin and per bucket: whoever attaches a bucket needs this on
it, and a production origin belongs in `AllowedOrigins` alongside the development one.
