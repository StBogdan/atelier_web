# Contributing

Thanks for looking. This is a small project with a narrow surface, so the most useful things to know are
what it is built on, what must not change, and how to check your work.

By contributing you agree your work is licensed under the MIT License, the same as the rest of the
repository. There is no CLA and nothing to sign.

## Getting it running

```sh
./run.sh     # then open http://127.0.0.1:3000/workspaces/
```

`run.sh` builds the cloud app, starts the editor container, and serves both from one origin. The first run
compiles the editor, which takes a few minutes. Everything about it, including the two-apps-by-hand path
and the no-container path, is in [`README.md`](README.md).

## Checking your work

```sh
cd server && cargo test && cargo clippy --all-targets -- -D warnings
cd web && npm ci && npm run check && npm run format:check && npm run build
```

Run those before you push; there is no CI for them yet.

The cloud app is formatted rather than hand-wrapped: `npm run format` in `web/` runs Prettier with
`prettier-plugin-svelte`, on Prettier's own defaults, and `npm run format:check` is the same thing as a
test. Its config is `web/.prettierrc.json` and it owns `web/`, so the shape of a line there is the
formatter's business and not something to argue with in review. `cargo fmt` is deliberately not part of it:
the Rust is not rustfmt-formatted, and reformatting it would bury real changes. Elsewhere — the Rust, the
walkthroughs in `test/` — match the style of the file you are editing.

The end-to-end walkthroughs need a browser and a running server, and are the only way to check the OPFS
handoff:

```sh
cd test && npm ci && npm run walkthrough   # create, open, edit, save, commit
cd test && npm run attach                  # the bucket flow, against a local S3 stand-in
```

`npm run attach` needs no bucket, no account and no credentials: `test/s3-stub.mjs` is an in-process S3
stand-in, started with credentials that exist nowhere, so a signature it accepts proves the browser signed
with what the form was given.

## The editor patch

The editor is upstream and is never edited in place. `photocraft/` is a submodule pinned to a release
commit, and the only thing applied to it is [`hook/atelier_web.patch`](hook/atelier_web.patch). The patch is
a first-class artifact here:

- Edit the patch, not a checkout. `hook/README.md` says how.
- Keep it inside its documented footprint. `patch.yml` asserts that in CI, and a red build is the point:
  drift from upstream should be a red build, not a surprise.
- The wasm budget is a hard gate (25 MiB, Cloudflare's per-file limit). The patch adds no wasm
  dependencies; keep it that way.

## What not to commit

- **Secrets.** No API keys, no tokens, no `.env`. The repository needs none to build or test, and the tests
  are written around that on purpose.
- **Build output.** `server/target/`, `web/build/`, `web/.svelte-kit/` and `node_modules/` are ignored
  already; check `git status` before you commit.
- **Anything under `photocraft/`.** It is upstream, and a change there belongs in the patch or upstream.

## Commits and pull requests

Commit messages are imperative and descriptive, and explain the why where it is not obvious: `Give a
workspace a bucket of its own, signed in the browser`. `git log` is the convention to follow.

A pull request is easier to review when it is one idea, and when the design documents still describe the
system afterwards. If your change alters behaviour the design describes, update the design in the same
change — the links in `README.md` point at it.
