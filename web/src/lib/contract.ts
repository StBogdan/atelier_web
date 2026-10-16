/**
 * The OPFS contract of `atelier_web/contract/protocol.md`, protocol 1.
 *
 * This module is Atelier Cloud's side of it: it creates the space, publishes `provider.json`,
 * renders the catalog, derives each project's state from the document the editor wrote, and
 * commits a revision. The editor's side is `../../hook/atelier_web.patch`.
 *
 * Everything the UI shows is derived here from OPFS (design, File Ownership): nothing is remembered in
 * memory between visits, so a reload, a second tab or an evicted-then-restored store all converge
 * on the same answer.
 */

import {
  SPACE,
  directory,
  files,
  hasDirectory,
  lockName,
  opfs,
  readBytes,
  readJson,
  remove,
  stat,
  subdirectories,
  writeBytes,
  writeJson,
  withLock,
  type Directory,
} from "./opfs";
import {
  difference,
  isPcraft,
  objectSet,
  previewEntry,
  readDirectory,
  readEntry,
  type Difference,
  type ZipEntry,
} from "./pcraft";

export const PROTOCOL = 1;
export const PROVIDER_NAME = "Atelier Cloud";

export const PROVIDER_FILE = "provider.json";
export const CATALOG_FILE = "workspaces.json";
export const META_FILE = "meta.json";
export const PENDING_FILE = "pending.json";
export const THUMB_FILE = "thumb.png";

/**
 * The names the provider keeps inside a project directory. Everything else in there is a document.
 * A project's documents are therefore whatever the editor saved into it and whatever a workspace was
 * started from, which is how a workspace can be seeded from a PSD or a PNG.
 */
export const PROJECT_FILES = new Set([
  META_FILE,
  PENDING_FILE,
  THUMB_FILE,
  "bucket.json",
]);

/** The document name an empty project's first save lands under, when nothing suggests a better one. */
export const DEFAULT_DOCUMENT = "doc.pcraft";

/** The extension the editor saves as, and the only kind of document a revision can describe. */
export const DOCUMENT_EXTENSION = "pcraft";

export type SyncState = "local";

/**
 * Where the bucket holds this project's document. Additive to protocol 1: a consumer that does not
 * know it ignores it, and the provider keeps its own state in its own file
 * (`contract/protocol.md`, Versioning).
 */
export interface Remote {
  /** The logical key, without the deployment's prefix. */
  key: string;
  /** `sha256:<hex>` of the bytes that were uploaded, so "is the bucket copy this document?" costs
   * nothing more than the hash the Changes panel already computes. */
  hash: string;
  size: number;
  at: string;
  /** The bucket's ETag, when its CORS policy exposes one. */
  etag: string | null;
}

export interface Revision {
  /** `sha256:<hex>` of the committed document. */
  hash: string;
  size: number;
  /** The document's `File.lastModified` when it was committed: the cheap "did it change?" check. */
  modified: number;
  /** Every content-addressed entry of the committed document, name to size. */
  objects: Record<string, number>;
}

export interface Meta {
  protocol: number;
  id: string;
  name: string;
  role: "owner";
  document: string | null;
  createdAt: string;
  updatedAt: string;
  rev: number;
  dirty: boolean;
  size: number;
  sync: { state: SyncState; at: string; remote?: Remote | null };
  revision: Revision | null;
}

export interface Workspace {
  id: string;
  name: string;
  role: "owner";
  rev: number;
  dirty: boolean;
  /** Every document's bytes as they are on disk now, not as of the revision. */
  size: number;
  document: string | null;
  updatedAt: string;
  thumb: boolean;
  /** Set when the project directory is there but its metadata is not. */
  broken?: string;
  /**
   * Every document in the project, in name order (design, Documents). `document` above is the one the
   * revision describes; the rest are documents the editor saved that no revision covers yet.
   */
  documents: WorkspaceDocument[];
}

/** One document in a project, as a listing shows it. */
export interface WorkspaceDocument {
  name: string;
  size: number;
  /** The file's `File.lastModified`. */
  modified: number;
  /** Whether this document, in these bytes, is what the project's revision recorded. */
  dirty: boolean;
}

export interface Pending {
  protocol: number;
  project: string;
  document: string;
  rev: number;
  hash: string;
  size: number;
  modified: number;
  at: string;
  added: number;
  changed: number;
  removed: number;
  bytes: number;
  unchanged: number;
  unchangedBytes: number;
}

export interface Storage {
  /** `null` until the first check: the landing page must not accuse the browser too early. */
  supported: boolean | null;
  usage: number;
  quota: number;
  persisted: boolean;
  /** `persist()` has not been asked yet for this origin, in this browser profile. */
  asked: boolean;
}

const PERSIST_KEY = "atelier-cloud:persistence-asked";

/** `atelier-cloud/`, created and made valid if it is not there yet. */
export async function ensureSpace(): Promise<Directory> {
  const space = await directory(await opfs(), SPACE, true);
  const provider = await readJson<{ protocol?: number }>(space, PROVIDER_FILE);
  if (provider?.protocol !== PROTOCOL) {
    await writeJson(space, PROVIDER_FILE, {
      protocol: PROTOCOL,
      name: PROVIDER_NAME,
    });
  }
  await directory(space, "projects", true);
  await directory(space, "index", true);
  await directory(space, "tmp", true);
  await sweepStaging(space);
  return space;
}

async function projectsDir(space: Directory): Promise<Directory> {
  return await directory(space, "projects", true);
}

async function projectDir(
  space: Directory,
  project: string,
): Promise<Directory> {
  return await directory(await projectsDir(space), project);
}

async function outboxDir(
  space: Directory,
  project: string,
  create: boolean,
): Promise<Directory> {
  return await directory(
    await directory(space, "outbox", create),
    project,
    create,
  );
}

/** Staging files are transient: anything left behind is from a tab that did not finish. */
async function sweepStaging(space: Directory): Promise<void> {
  const staging = await directory(space, "tmp", true);
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const name of await files(staging)) {
    const info = await stat(staging, name);
    if (info && info.modified < cutoff)
      await remove(staging, name).catch(() => {});
  }
}

/**
 * Every document a project holds, in name order (design, Documents). A document is any file in the
 * project directory that is not the provider's own (`meta.json`, `bucket.json`, `thumb.png`) and not
 * a one-save-back shadow: what a workspace was started from, and what the editor has saved into it.
 */
export async function documentNames(dir: Directory): Promise<string[]> {
  return (await files(dir))
    .filter((name) => !PROJECT_FILES.has(name) && !name.endsWith(".prev"))
    .sort();
}

/** The document of a project: the first in name order, which is all a bare listing needs. */
export async function documentName(dir: Directory): Promise<string | null> {
  return (await documentNames(dir))[0] ?? null;
}

export async function readMeta(
  space: Directory,
  project: string,
): Promise<Meta | null> {
  return await readJson<Meta>(await projectDir(space, project), META_FILE);
}

/**
 * A project's state as the catalog shows it: no document bytes are read (design, The Workspace Grid).
 *
 * A project holds as many documents as the editor has saved into it. `meta.json` names the one its
 * revision describes — the document the panels act on — and every other one is listed beside it,
 * uncommitted by definition, because the revision does not describe it.
 */
export async function inspect(
  space: Directory,
  project: string,
): Promise<Workspace> {
  const dir = await projectDir(space, project);
  const meta = await readJson<Meta>(dir, META_FILE);
  const names = await documentNames(dir);
  const recorded = meta?.document ?? null;
  const document =
    recorded && names.includes(recorded) ? recorded : (names[0] ?? null);
  const revision = meta?.revision ?? null;
  const documents: WorkspaceDocument[] = [];
  for (const name of names) {
    const info = await stat(dir, name);
    const size = info?.size ?? 0;
    documents.push({
      name,
      size,
      modified: info?.modified ?? 0,
      // Only the document the revision describes can be what it recorded.
      dirty:
        name !== document || revision === null
          ? true
          : info === null ||
            info.size !== revision.size ||
            info.modified !== revision.modified,
    });
  }
  const size = documents.reduce((total, entry) => total + entry.size, 0);
  // A workspace is uncommitted when the document a commit would record is not what the revision
  // recorded. Anything else in the project, a PNG or a second .pcraft the revision cannot describe,
  // is held as it is and does not set this: the badge appears exactly where Commit can clear it.
  const target =
    recorded && names.includes(recorded)
      ? recorded
      : (names.find((name) => isPcraftName(name)) ?? null);
  const targetInfo = target ? await stat(dir, target) : null;
  const dirty =
    target === null
      ? false
      : revision === null ||
        targetInfo === null ||
        targetInfo.size !== revision.size ||
        targetInfo.modified !== revision.modified;
  const thumb = (await stat(dir, THUMB_FILE)) !== null;

  if (!meta) {
    return {
      id: project,
      name: project,
      role: "owner",
      rev: 0,
      dirty,
      size,
      document,
      updatedAt: new Date(0).toISOString(),
      thumb,
      documents,
      broken: "no meta.json",
    };
  }

  // The flag is the provider's derivation, so keep it in step with the file, not with the past.
  if (meta.dirty !== dirty) await writeJson(dir, META_FILE, { ...meta, dirty });
  if (!dirty) await clearPending(space, project);

  return {
    id: project,
    name: meta.name,
    role: meta.role ?? "owner",
    rev: meta.rev,
    dirty,
    size,
    document,
    updatedAt: meta.updatedAt,
    thumb,
    documents,
  };
}

/** Scan the space and rewrite the catalog cache (`contract/protocol.md`, `index/workspaces.json`). */
export async function scan(space: Directory): Promise<Workspace[]> {
  const projects = await projectsDir(space);
  const workspaces: Workspace[] = [];
  for (const project of await subdirectories(projects))
    workspaces.push(await inspect(space, project));
  workspaces.sort(
    (a, b) =>
      b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name),
  );
  await writeJson(await directory(space, "index", true), CATALOG_FILE, {
    protocol: PROTOCOL,
    updatedAt: new Date().toISOString(),
    workspaces: workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      role: workspace.role,
      rev: workspace.rev,
      dirty: workspace.dirty,
      bytes: workspace.size,
      documents: workspace.documents.length,
      document: workspace.document,
      updatedAt: workspace.updatedAt,
      thumb: workspace.thumb,
    })),
  });
  return workspaces;
}

export async function hash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

/**
 * Where a project's document lives in the bucket: `<project>/<document>`, the logical key. The
 * workspace's own prefix is joined onto it by the signer (`./sigv4.ts`), so this is what
 * `sync.remote.key` records, and it does not move when the prefix changes.
 */
export function objectKey(
  project: string,
  document: string = DEFAULT_DOCUMENT,
): string {
  return `${project}/${document}`;
}

/** `doc.pcraft` for a suggested display name, keeping the extension the contract requires. */
export function documentFileName(name: string): string {
  const base = sanitiseDocumentName(name);
  if (!base) return DEFAULT_DOCUMENT;
  return extensionOf(base) ? base : `${base}.${DOCUMENT_EXTENSION}`;
}

/** Drop any path part, leading dots and a trailing dot: a document name is a file name, nothing else. */
export function sanitiseDocumentName(name: string): string {
  return name
    .replace(/^[\s.]+|[\s]+$/g, "")
    .replace(/[/\\]/g, "-")
    .replace(/\.+$/, "");
}

/** `.psd`, `.pcraft` — the part of a name the editor picks its reader by. Empty when there is none. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot) : "";
}

/** Whether a name is one the editor saves as a `.pcraft` — the only kind a revision can describe. */
export function isPcraftName(name: string): boolean {
  return name.toLowerCase().endsWith(`.${DOCUMENT_EXTENSION}`);
}

export interface NewProject {
  name: string;
  /**
   * The documents to start from, in the order they were chosen. Empty for a project with no document
   * yet. Several are written as they come; the one the revision describes is the first `.pcraft` among
   * them, because only a `.pcraft` can be recorded (Documents).
   */
  documents?: { name: string; bytes: Uint8Array }[];
}

/** Create a project and commit its first revision. The provider owns project creation (design, File Ownership). */
export async function createProject(
  space: Directory,
  { name, documents = [] }: NewProject,
): Promise<Workspace> {
  const id = crypto.randomUUID();
  const dir = await directory(await projectsDir(space), id, true);
  const now = new Date().toISOString();
  const meta: Meta = {
    protocol: PROTOCOL,
    id,
    name: name.trim() || "Untitled workspace",
    role: "owner",
    document: null,
    createdAt: now,
    updatedAt: now,
    rev: 0,
    dirty: false,
    size: 0,
    sync: { state: "local", at: now },
    revision: null,
  };
  await writeJson(dir, META_FILE, meta);
  if (documents.length) {
    for (const document of documents)
      await writeBytes(dir, document.name, document.bytes);
    // The recorded document is the first `.pcraft` chosen: a revision is that format's object set, so
    // a workspace started from a PSD alone is committed only once the editor saves one.
    const recordable = documents.find((document) => isPcraft(document.bytes));
    const recorded = recordable ?? documents[0];
    await writeJson(dir, META_FILE, {
      ...meta,
      document: recordable ? recorded.name : null,
      size: recorded.bytes.length,
      dirty: true,
    });
    if (recordable) await commit(space, id);
  }
  return await inspect(space, id);
}

export interface ReadDocument {
  name: string;
  bytes: Uint8Array;
  /**
   * Whether these bytes are a `.pcraft` document — the only kind a revision can describe, because
   * the object set, the diff and the thumbnail all come out of its ZIP. A workspace started from a
   * PSD or a PNG holds a document the editor can open and save, and no revision until it saves one.
   */
  pcraft: boolean;
  entries: ZipEntry[];
  objects: Map<string, number>;
}

/** The document plus its parsed object set, under the shared lock the editor's save respects. */
export async function readDocument(
  space: Directory,
  project: string,
  document?: string,
): Promise<ReadDocument | null> {
  const dir = await projectDir(space, project);
  const name = document ?? (await documentName(dir));
  if (!name) return null;
  const bytes = await withLock(
    lockName(project),
    "shared",
    async () => await readBytes(dir, name),
  );
  if (!isPcraft(bytes))
    return { name, bytes, pcraft: false, entries: [], objects: new Map() };
  const entries = readDirectory(bytes);
  return {
    name,
    bytes,
    pcraft: true,
    entries,
    objects: objectSet(entries),
  };
}

/** The exact change against the committed revision, and what the Changes panel renders (design, Where Cloud State Is Surfaced). */
export interface Change {
  document: string;
  difference: Difference;
  hash: string;
  size: number;
  modified: number;
}

export async function pendingChange(
  space: Directory,
  project: string,
  meta: Meta,
  document?: string,
): Promise<Change | null> {
  const read = await readDocument(space, project, document);
  if (!read) return null;
  // A document that is not a .pcraft has no object set to diff, and no revision can describe it.
  if (!read.pcraft) return null;
  const previous = meta.revision?.objects ?? {};
  const difference_ = difference(previous, read.objects, read.entries);
  const info = await stat(await projectDir(space, project), read.name);
  const change: Change = {
    document: read.name,
    difference: difference_,
    hash: await hash(read.bytes),
    size: read.bytes.length,
    modified: info?.modified ?? Date.now(),
  };
  if (meta.revision && change.hash === meta.revision.hash) return null;
  await writeJson(await outboxDir(space, project, true), PENDING_FILE, {
    protocol: PROTOCOL,
    project,
    document: change.document,
    rev: meta.rev,
    hash: change.hash,
    size: change.size,
    modified: change.modified,
    at: new Date().toISOString(),
    added: difference_.added.length,
    changed: difference_.changed.length,
    removed: difference_.removed,
    bytes: difference_.bytes,
    unchanged: difference_.unchanged,
    unchangedBytes: difference_.unchangedBytes,
  } satisfies Pending);
  return change;
}

async function clearPending(space: Directory, project: string): Promise<void> {
  if (
    !(await hasDirectory(space, "outbox")) ||
    !(await hasDirectory(await directory(space, "outbox"), project))
  )
    return;
  await remove(await outboxDir(space, project, false), PENDING_FILE).catch(
    () => {},
  );
}

/**
 * Commit the document as a new revision: record its object set, refresh the thumbnail, and clear
 * the pending change. In M1 the revision is recorded locally; M2 uploads the same set (design, Delta Sync).
 */
export async function commit(
  space: Directory,
  project: string,
  document?: string,
): Promise<Meta> {
  const dir = await projectDir(space, project);
  return await withLock(lockName(project), "exclusive", async () => {
    const meta = (await readJson<Meta>(dir, META_FILE)) ?? null;
    if (!meta) throw new Error("this project has no meta.json");
    // What to record: the caller's document, else the one the revision describes, else the first
    // .pcraft, which is what a workspace started from several files has. Bare name order can put a
    // PNG first, and a revision cannot describe one.
    const names = await documentNames(dir);
    const wanted = document ?? meta.document ?? null;
    const name =
      wanted && names.includes(wanted)
        ? wanted
        : (names.find((candidate) => isPcraftName(candidate)) ?? names[0] ?? null);
    if (!name) throw new Error("this project has no document to commit");
    // A revision is the document's object set, so it can only describe a .pcraft.
    if (!isPcraft(await readBytes(dir, name)))
      throw new Error(
        `${name} is not a .pcraft yet: open it in the editor and save it as one to record a version`,
      );
    const bytes = await readBytes(dir, name);
    const info = await stat(dir, name);
    // The same bytes as the current revision would be a revision that says nothing, and `rev` is
    // what a reader counts.
    if (meta.document === name && meta.revision?.hash === (await hash(bytes))) {
      await clearPending(space, project);
      return meta;
    }
    const entries = readDirectory(bytes);
    const preview = previewEntry(entries);
    if (preview)
      await writeBytes(dir, THUMB_FILE, await readEntry(bytes, preview));
    const now = new Date().toISOString();
    const next: Meta = {
      ...meta,
      document: name,
      updatedAt: now,
      rev: meta.rev + 1,
      dirty: false,
      size: bytes.length,
      sync: { state: "local", at: now },
      revision: {
        hash: await hash(bytes),
        size: bytes.length,
        modified: info?.modified ?? Date.now(),
        objects: Object.fromEntries(objectSet(entries)),
      },
    };
    await writeJson(dir, META_FILE, next);
    await clearPending(space, project);
    return next;
  });
}

/**
 * Put back the previous bytes, the one destructive action in the provider (design, Where Cloud State Is Surfaced).
 *
 * `.prev` is the editor's, one save back (design, Saving; File Ownership), which is the committed revision when exactly
 * one save has happened since the commit. The answer says which of the two came back, so the UI can
 * be plain about it instead of pretending: M1 has no server holding the committed bytes.
 */
export async function discard(
  space: Directory,
  project: string,
  document?: string,
): Promise<"revision" | "previous"> {
  const dir = await projectDir(space, project);
  const meta = await readJson<Meta>(dir, META_FILE);
  const outcome = await withLock(lockName(project), "exclusive", async () => {
    const name = document ?? (await documentName(dir));
    if (!name) throw new Error("this project has no document");
    const previous = await readBytes(dir, `${name}.prev`).catch(() => null);
    if (!previous) throw new Error("there are no previous bytes to restore");
    await writeBytes(dir, name, previous);
    return (await hash(previous)) === meta?.revision?.hash
      ? ("revision" as const)
      : ("previous" as const);
  });
  await clearPending(space, project);
  await inspect(space, project);
  return outcome;
}

/**
 * Record that the document's bytes are in the bucket. Provider-owned state in `meta.json`, so the
 * answer to "is the bucket copy this document?" survives a reload (protocol, Versioning).
 */
export async function recordUpload(
  space: Directory,
  project: string,
  remote: Remote,
): Promise<Meta> {
  const dir = await projectDir(space, project);
  const meta = await readJson<Meta>(dir, META_FILE);
  if (!meta) throw new Error("this project has no meta.json");
  const next: Meta = { ...meta, sync: { ...meta.sync, remote } };
  await writeJson(dir, META_FILE, next);
  return next;
}

/**
 * Put bytes fetched from the bucket into the document slot, as a whole-document replace under the
 * project's exclusive lock — the same shape as `discard`, and the same hazard: an editor that has
 * the document open will write its own copy over this on its next save.
 *
 * This is one of the two places the provider writes the document itself (`contract/protocol.md`,
 * File Ownership). M2's "restore a revision" is the third, and lands here too.
 */
export async function restoreDocument(
  space: Directory,
  project: string,
  bytes: Uint8Array,
  document?: string,
): Promise<void> {
  const dir = await projectDir(space, project);
  await withLock(lockName(project), "exclusive", async () => {
    const name = document ?? (await documentName(dir)) ?? DEFAULT_DOCUMENT;
    await writeBytes(dir, name, bytes);
    const meta = await readJson<Meta>(dir, META_FILE);
    // `document` and `size` are the provider's record of the slot; the editor only ever writes
    // the file. `dirty` is left to `inspect`, which derives it.
    if (meta)
      await writeJson(dir, META_FILE, {
        ...meta,
        document: name,
        size: bytes.length,
      });
  });
  await inspect(space, project);
}

/** The committed document's bytes, and the previous ones when there are any: the export path. */
export async function documentBytes(
  space: Directory,
  project: string,
  previous = false,
  document?: string,
): Promise<{ name: string; bytes: Uint8Array } | null> {
  const dir = await projectDir(space, project);
  const name = document ?? (await documentName(dir));
  if (!name) return null;
  const file = previous ? `${name}.prev` : name;
  const bytes = await readBytes(dir, file).catch(() => null);
  if (!bytes) return null;
  // A previous copy downloads under the name it had, one save back: `photo.psd` is `photo.prev.psd`.
  const oneSaveBack = `${name.slice(0, name.length - extensionOf(name).length)}.prev${extensionOf(name)}`;
  return { name: previous ? oneSaveBack : name, bytes };
}

export async function rename(
  space: Directory,
  project: string,
  name: string,
): Promise<void> {
  const dir = await projectDir(space, project);
  const meta = await readJson<Meta>(dir, META_FILE);
  if (!meta) return;
  await writeJson(dir, META_FILE, {
    ...meta,
    name: name.trim() || meta.name,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Delete one document from a project: the document, its one-save-back `.prev`, and — when it was the
 * document the revision described — that record too, so the project is uncommitted again rather than
 * describing bytes that are gone. The exclusive lock is the one a save takes, so a delete cannot land
 * in the middle of one.
 *
 * The bucket copy is deliberately left where it is, the same as deleting a whole workspace: this is
 * not a delete-everywhere, and the object may be the only copy off this machine.
 */
export async function removeDocument(
  space: Directory,
  project: string,
  document: string,
): Promise<void> {
  const dir = await projectDir(space, project);
  await withLock(lockName(project), "exclusive", async () => {
    await remove(dir, document).catch(() => {});
    await remove(dir, `${document}.prev`).catch(() => {});
    const meta = await readJson<Meta>(dir, META_FILE);
    if (meta && meta.document === document)
      await writeJson(dir, META_FILE, {
        ...meta,
        document: null,
        revision: null,
        dirty: true,
        size: 0,
      });
  });
  await clearPending(space, project);
  await inspect(space, project);
}

/**
 * Rename a document inside its project: the file, its one-save-back copy beside it, and — when it was
 * the document the revision described — that record, so the revision follows the name rather than
 * pointing at a file that is gone.
 *
 * OPFS has no `move()` every browser has (design, Saving), so this is read, write, remove under the
 * project's exclusive lock. A name already taken in the project is refused rather than written over,
 * and the recorded bucket copy is forgotten: `sync.remote.key` names the *old* document, and the next
 * upload records the new one. Object storage has no rename, and the copy under the old name is left
 * where it is.
 */
export async function renameDocument(
  space: Directory,
  project: string,
  from: string,
  to: string,
): Promise<string> {
  // A name typed without an extension keeps the document's own: renaming `photo.psd` to `holiday`
  // gives `holiday.psd`, which is still a PSD to the editor that reads it.
  const base = sanitiseDocumentName(to);
  if (!base) throw new Error("a document needs a name");
  const name = extensionOf(base)
    ? base
    : `${base}${extensionOf(from) || `.${DOCUMENT_EXTENSION}`}`;
  if (name === from) return name;
  const dir = await projectDir(space, project);
  await withLock(lockName(project), "exclusive", async () => {
    const names = await documentNames(dir);
    if (!names.includes(from))
      throw new Error(`${from} is not in this workspace`);
    if (names.includes(name))
      throw new Error(`${name} is already in this workspace`);
    const bytes = await readBytes(dir, from);
    const previous = await readBytes(dir, `${from}.prev`).catch(() => null);
    await writeBytes(dir, name, bytes);
    await remove(dir, from).catch(() => {});
    // The one-save-back copy comes across only once the new document is in place.
    if (previous) {
      await writeBytes(dir, `${name}.prev`, previous);
      await remove(dir, `${from}.prev`).catch(() => {});
    }
    const meta = await readJson<Meta>(dir, META_FILE);
    if (meta && meta.document === from) {
      const { remote: _forgotten, ...sync } = meta.sync;
      await writeJson(dir, META_FILE, {
        ...meta,
        document: name,
        sync,
        updatedAt: new Date().toISOString(),
      });
    }
  });
  await inspect(space, project);
  return name;
}

export async function removeProject(
  space: Directory,
  project: string,
): Promise<void> {
  await remove(await projectsDir(space), project, true);
  await remove(await directory(space, "outbox", true), project, true).catch(
    () => {},
  );
}

export async function storage(): Promise<Storage> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate)
    return {
      supported: false,
      usage: 0,
      quota: 0,
      persisted: false,
      asked: true,
    };
  const estimate = await navigator.storage.estimate();
  return {
    supported: true,
    usage: estimate.usage ?? 0,
    quota: estimate.quota ?? 0,
    persisted: await navigator.storage.persisted(),
    asked: localStorage.getItem(PERSIST_KEY) === "1",
  };
}

/**
 * Ask the browser to keep this origin's storage (design, Design Rules). Worth doing on a first meaningful
 * visit, and only once: without it the whole cloudspace is evictable under pressure.
 */
export async function requestPersistence(): Promise<boolean> {
  localStorage.setItem(PERSIST_KEY, "1");
  if (typeof navigator === "undefined" || !navigator.storage?.persist)
    return false;
  return await navigator.storage.persist();
}
