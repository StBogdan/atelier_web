/**
 * The OPFS layout of `docs/atelier_design.md`, protocol 1: Atelier Cloud's side of it.
 * The editor's side is `../../hook/atelier_web.patch`.
 *
 * Everything the UI shows is derived here from OPFS: nothing is remembered in memory between visits,
 * so a reload, a second tab or an evicted-then-restored store all converge on the same answer.
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
  isPcraft,
  objectSet,
  previewEntry,
  readDirectory,
  readEntry,
  type ZipEntry,
} from "./pcraft";
import {
  DEFAULT_EDITOR,
  editorFor,
  type Editor,
  type EditorId,
} from "./editors";
import { extensionOf } from "./format";

export const PROTOCOL = 1;
export const PROVIDER_NAME = "Atelier Cloud";

export const PROVIDER_FILE = "provider.json";
export const CATALOG_FILE = "workspaces.json";
export const META_FILE = "meta.json";
/** Left in a project by older builds as the staging record for a pending diff; nothing writes it now. */
export const PENDING_FILE = "pending.json";
export const THUMB_FILE = "thumb.png";

/**
 * The names the provider keeps inside a project directory; everything else in there is a document,
 * so a workspace can be seeded from a PSD or a PNG as readily as from a `.pcraft`.
 */
export const PROJECT_FILES = new Set([
  META_FILE,
  PENDING_FILE,
  THUMB_FILE,
  "bucket.json",
]);

/** What an empty project's first save lands under, when nothing suggests a better name. */
export const DEFAULT_DOCUMENT = DEFAULT_EDITOR.defaultDocument;

/** The extension the editor saves as, and the only kind of document a revision can describe. */
export const DOCUMENT_EXTENSION = DEFAULT_EDITOR.extension;

export type SyncState = "local";

/**
 * Where the bucket holds this project's document. Additive to protocol 1, so a consumer that does not
 * know it ignores it.
 */
export interface Remote {
  /** The logical key, without the deployment's prefix. */
  key: string;
  /** `sha256:<hex>` of the bytes that were uploaded, so "is the bucket copy this document?" costs
   * nothing more than the hash the workspace's version already holds. */
  hash: string;
  size: number;
  at: string;
  /** The bucket's ETag, when its CORS policy exposes one. */
  etag: string | null;
}

/** What a document can record: a `.pcraft` object set, a whole file, or nothing yet. */
export type DocumentKind = "objects" | "whole" | "none";

/** Whether a name and its bytes are a recordable document, and which kind of revision it makes. */
export function documentKind(name: string, bytes?: Uint8Array): DocumentKind {
  const lower = name.toLowerCase();
  if (lower.endsWith(`.${DOCUMENT_EXTENSION}`))
    return !bytes || isPcraft(bytes) ? "objects" : "none";
  if (lower.endsWith(".pdf")) return "whole";
  return "none";
}

export interface Revision {
  /** What this revision records. Absent on revisions written before PDFs were supported. */
  kind?: DocumentKind;
  /** `sha256:<hex>` of the committed document. */
  hash: string;
  size: number;
  /** The document's `File.lastModified` when it was committed: the cheap "did it change?" check. */
  modified: number;
  /** Every content-addressed entry of the committed document, name to size. Empty for a whole file. */
  objects: Record<string, number>;
}

export interface Meta {
  protocol: number;
  id: string;
  name: string;
  role: "owner";
  /** The editor a workspace with no document opens in. Derived when absent. */
  editor?: EditorId;
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
  /** The editor this workspace opens in when its recorded document does not choose one. */
  editor: EditorId;
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
   * Every document in the project, in name order. `document` above is the one the revision describes.
   */
  documents: WorkspaceDocument[];
}

/** One document in a project, as a listing shows it. */
export interface WorkspaceDocument {
  name: string;
  size: number;
  /** The file's `File.lastModified`. */
  modified: number;
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
 * Every document a project holds: any file that is not the provider's own and not a one-save-back
 * shadow.
 */
export async function documentNames(dir: Directory): Promise<string[]> {
  // `files` already sorts.
  return (await files(dir)).filter(
    (name) => !PROJECT_FILES.has(name) && !name.endsWith(".prev"),
  );
}

/** The first document in name order, which is all a bare listing needs. */
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
 * A project's state as the catalog shows it. No document bytes are read: `meta.json` names the
 * document its revision describes, and every other document in the project is uncommitted by
 * definition, because the revision does not describe it.
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
  const editor = editorFor(document, meta?.editor).id;
  const revision = meta?.revision ?? null;
  const documents: WorkspaceDocument[] = [];
  for (const name of names) {
    const info = await stat(dir, name);
    const size = info?.size ?? 0;
    documents.push({
      name,
      size,
      modified: info?.modified ?? 0,
    });
  }
  const size = documents.reduce((total, entry) => total + entry.size, 0);
  // A workspace is uncommitted when the document a commit would record is not what the revision
  // recorded. Anything else in the project does not set this, so the badge appears exactly where
  // Commit can clear it.
  const target =
    recorded && names.includes(recorded)
      ? recorded
      : (names.find((name) => documentKind(name) === "objects") ??
        names.find((name) => documentKind(name) === "whole") ??
        null);
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
      editor,
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
    editor,
    rev: meta.rev,
    dirty,
    size,
    document,
    updatedAt: meta.updatedAt,
    thumb,
    documents,
  };
}

/** Scan the space and rewrite the catalog cache. */
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
      editor: workspace.editor,
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
 * The logical key of a project's document, `<project>/<document>`, before the workspace's prefix is
 * joined on by the signer. This is what `sync.remote.key` records, and it does not move when the
 * prefix changes.
 */
export function objectKey(
  project: string,
  document: string = DEFAULT_DOCUMENT,
): string {
  return `${project}/${document}`;
}

/** A suggested display name, keeping an extension it has and adding the editor's when it has none. */
export function documentFileName(
  name: string,
  editor: Editor = DEFAULT_EDITOR,
): string {
  const base = sanitiseDocumentName(name);
  if (!base) return editor.defaultDocument;
  return extensionOf(base) ? base : `${base}.${editor.extension}`;
}

/** Drop any path part, leading dots and a trailing dot: a document name is a file name, nothing else. */
export function sanitiseDocumentName(name: string): string {
  return name
    .replace(/^[\s.]+|[\s]+$/g, "")
    .replace(/[/\\]/g, "-")
    .replace(/\.+$/, "");
}

/** Whether a name is one the editor saves as a `.pcraft` — the only kind a revision can describe. */
export function isPcraftName(name: string): boolean {
  return name.toLowerCase().endsWith(`.${DOCUMENT_EXTENSION}`);
}

/**
 * The document a revision would describe: the recorded one, else the first `.pcraft`, then the first
 * `.pdf`, then whatever the project holds. A name order alone can put a PNG first.
 */
export function preferredDocument(
  names: string[],
  recorded: string | null,
): string | null {
  if (recorded && names.includes(recorded)) return recorded;
  return (
    names.find((name) => documentKind(name) === "objects") ??
    names.find((name) => documentKind(name) === "whole") ??
    names[0] ??
    null
  );
}

export interface NewProject {
  name: string;
  /** Which editor an empty workspace should open in. PhotoCraft unless a caller says otherwise. */
  editor?: EditorId;
  /**
   * The documents to start from, in the order chosen. The one a revision describes is the first
   * that can be recorded: a `.pcraft` or a `.pdf`.
   */
  documents?: { name: string; bytes: Uint8Array }[];
}

/** Create a project and commit its first revision. */
export async function createProject(
  space: Directory,
  { name, editor = DEFAULT_EDITOR.id, documents = [] }: NewProject,
): Promise<Workspace> {
  const id = crypto.randomUUID();
  const dir = await directory(await projectsDir(space), id, true);
  const now = new Date().toISOString();
  const meta: Meta = {
    protocol: PROTOCOL,
    id,
    name: name.trim() || "Untitled workspace",
    role: "owner",
    editor,
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
    // A revision is a `.pcraft` object set or a whole file, so a workspace started from a PSD alone
    // is committed only once an editor saves one.
    const recordable = documents.find(
      (document) => documentKind(document.name, document.bytes) !== "none",
    );
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
  /** What this document can record: its object set, its whole bytes, or nothing yet. */
  kind: DocumentKind;
  entries: ZipEntry[];
  objects: Map<string, number>;
}

/**
 * The document plus its parsed object set, under the shared lock the editor's save respects.
 *
 * With none named, this is the workspace's recorded document, else the first one that can be
 * recorded. A workspace may hold several files, and name order can put a PNG first; the recorded
 * document is the one a commit and an upload both mean.
 */
export async function readDocument(
  space: Directory,
  project: string,
  document?: string,
): Promise<ReadDocument | null> {
  const dir = await projectDir(space, project);
  const name =
    document ??
    preferredDocument(
      await documentNames(dir),
      (await readJson<Meta>(dir, META_FILE))?.document ?? null,
    );
  if (!name) return null;
  const bytes = await withLock(
    lockName(project),
    "shared",
    async () => await readBytes(dir, name),
  );
  const kind = documentKind(name, bytes);
  if (kind !== "objects")
    return { name, bytes, kind, entries: [], objects: new Map() };
  const entries = readDirectory(bytes);
  return {
    name,
    bytes,
    kind,
    entries,
    objects: objectSet(entries),
  };
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
 * Commit the document as a new revision: record its object set or its whole bytes, refresh the
 * thumbnail when it has one, and clear the pending change. The revision is recorded locally;
 * uploading the same bytes is the bucket's job.
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
    // What to record: the caller's document, else the recorded one, else the first `.pcraft`, then
    // the first `.pdf`. Bare name order can put a PNG first, and no revision can describe one.
    const names = await documentNames(dir);
    const wanted =
      document && names.includes(document) ? document : meta.document;
    const name = preferredDocument(names, wanted);
    if (!name) throw new Error("this project has no document to commit");
    const bytes = await readBytes(dir, name);
    const kind = documentKind(name, bytes);
    if (kind === "none")
      throw new Error(
        `${name} cannot be recorded yet: open it in an editor that saves a .pcraft or a .pdf`,
      );
    const info = await stat(dir, name);
    // The same bytes as the current revision would be a revision that says nothing, and `rev` is
    // what a reader counts. The file's own modified time still moves, and `inspect` compares that,
    // so the recorded revision follows it instead.
    if (meta.document === name && meta.revision?.hash === (await hash(bytes))) {
      const next: Meta = {
        ...meta,
        size: bytes.length,
        revision: {
          ...meta.revision,
          kind,
          size: bytes.length,
          modified: info?.modified ?? meta.revision.modified,
        },
      };
      await writeJson(dir, META_FILE, next);
      await clearPending(space, project);
      return next;
    }
    const entries = kind === "objects" ? readDirectory(bytes) : [];
    const preview = kind === "objects" ? previewEntry(entries) : undefined;
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
      // The bucket copy the workspace already had stays on record: a new version does not un-upload
      // the last one, and comparing the two hashes is how the page says the bucket is behind.
      sync: { ...meta.sync, state: "local", at: now },
      revision: {
        kind,
        hash: await hash(bytes),
        size: bytes.length,
        modified: info?.modified ?? Date.now(),
        objects:
          kind === "objects" ? Object.fromEntries(objectSet(entries)) : {},
      },
    };
    await writeJson(dir, META_FILE, next);
    await clearPending(space, project);
    return next;
  });
}

/**
 * Record the document as this workspace's version when it has moved since the last one. Saving in an
 * editor is the only way a document changes, so this is what a Record button used to be: whichever
 * provider page sees the save first records it.
 */
export async function recordIfDirty(
  space: Directory,
  project: string,
): Promise<boolean> {
  if (!(await inspect(space, project)).dirty) return false;
  await commit(space, project);
  return true;
}

/**
 * Write a document an embedded editor sent back, under the project lock. The previous bytes stay
 * beside it as `<name>.prev`. The editor has no filesystem access, so this is the write for that
 * route.
 */
export async function saveFromEditor(
  space: Directory,
  project: string,
  name: string,
  bytes: Uint8Array,
): Promise<string> {
  const safe = sanitiseDocumentName(name);
  if (!safe) throw new Error("the editor sent a save with no name");
  if (PROJECT_FILES.has(safe) || safe.endsWith(".prev"))
    throw new Error(`${safe} is not a document`);
  const dir = await projectDir(space, project);
  await withLock(lockName(project), "exclusive", async () => {
    const previous = await readBytes(dir, safe).catch(() => null);
    if (previous) await writeBytes(dir, `${safe}.prev`, previous);
    await writeBytes(dir, safe, bytes);
  });
  return safe;
}

/**
 * Record that the document's bytes are in the bucket, so "is the bucket copy this document?" survives
 * a reload.
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
 * project's exclusive lock. One of the few places the provider writes the document itself, and it
 * carries a hazard: an editor that has the document open writes its own copy back over this on its
 * next save.
 */
export async function restoreDocument(
  space: Directory,
  project: string,
  bytes: Uint8Array,
  document?: string,
): Promise<void> {
  const dir = await projectDir(space, project);
  await withLock(lockName(project), "exclusive", async () => {
    const meta = await readJson<Meta>(dir, META_FILE);
    const name =
      document ??
      preferredDocument(await documentNames(dir), meta?.document ?? null) ??
      DEFAULT_DOCUMENT;
    await writeBytes(dir, name, bytes);
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

/** One document's bytes for the export path: the named one, or the workspace's recorded document. */
export async function documentBytes(
  space: Directory,
  project: string,
  document?: string,
): Promise<{ name: string; bytes: Uint8Array } | null> {
  const dir = await projectDir(space, project);
  const name =
    document ??
    preferredDocument(
      await documentNames(dir),
      (await readJson<Meta>(dir, META_FILE))?.document ?? null,
    );
  if (!name) return null;
  const bytes = await readBytes(dir, name).catch(() => null);
  if (!bytes) return null;
  return { name, bytes };
}

/** One document's name, bytes and timestamp, for the whole-workspace download. */
export interface DocumentFile {
  name: string;
  bytes: Uint8Array;
  modified: number;
}

/**
 * Every document the project holds, with its bytes. The one-save-back `.prev` copies and the
 * project's own files are not documents, so neither is in here: this is what the workspace shows.
 */
export async function documentFiles(
  space: Directory,
  project: string,
): Promise<DocumentFile[]> {
  const dir = await projectDir(space, project);
  const out: DocumentFile[] = [];
  for (const name of await documentNames(dir)) {
    const bytes = await readBytes(dir, name).catch(() => null);
    if (!bytes) continue;
    const info = await stat(dir, name);
    out.push({ name, bytes, modified: info?.modified ?? Date.now() });
  }
  return out;
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
 * Delete one document: the document, its one-save-back `.prev`, and — when it was the document the
 * revision described — that record too, so the project is uncommitted again rather than describing
 * bytes that are gone. The bucket copy is deliberately left where it is, since the object may be the
 * only copy off this machine.
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
 * Rename a document: the file, its one-save-back copy, and — when the revision described it — that
 * record, so the revision follows the name rather than pointing at a file that is gone.
 *
 * OPFS has no `move()` every browser has, so this is read, write, remove under the project's exclusive
 * lock. A name already taken in the project is refused rather than written over. The recorded bucket
 * copy is forgotten, since `sync.remote.key` names the old document, and object storage has no rename.
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
 * Ask the browser to keep this origin's storage. Without it the whole cloudspace is evictable under
 * pressure.
 */
export async function requestPersistence(): Promise<boolean> {
  localStorage.setItem(PERSIST_KEY, "1");
  if (typeof navigator === "undefined" || !navigator.storage?.persist)
    return false;
  return await navigator.storage.persist();
}
