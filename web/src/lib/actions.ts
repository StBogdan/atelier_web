/**
 * What can be done to a workspace without opening it: keep it (a revision, then its bucket copy) or take
 * it away (the document, to this computer). The workspace page asks for the same things, so both go
 * through here and behave alike.
 *
 * Design: [Design Rules](../…/docs/atelier_web_design.md) — small, frequent commits are the durability,
 * `outbox/` is staging, and the bucket is the copy that is not this machine. Everything here signs in the
 * browser, so no server sees a credential.
 */
import { readAttachment, uploadObject } from "./bucket";
import {
  commit,
  documentBytes,
  documentFiles,
  hash,
  objectKey,
  pendingChange,
  readDocument,
  readMeta,
  recordUpload,
  type Meta,
} from "./contract";
import type { Directory } from "./opfs";
import { zip } from "./zip";

export interface CommitResult {
  /** Whether the document became a new revision. */
  committed: boolean;
  /** The revision the workspace is at now. */
  rev: number;
  /** What went to the bucket, if the workspace has one attached. */
  uploaded: { name: string; size: number; where: string } | null;
}

/**
 * Copy the workspace's document to its bucket, on a URL signed here. Fails when there is no document or no
 * bucket, because both are the caller's to have arranged first.
 */
export async function uploadDocument(
  space: Directory,
  project: string,
): Promise<{ name: string; size: number; where: string }> {
  const document = await readDocument(space, project);
  if (!document) throw new Error("this workspace has no document yet");
  const attachment = await readAttachment(space, project);
  if (!attachment)
    throw new Error("no bucket is attached to this workspace yet");
  const where = objectKey(project, document.name);
  const { etag } = await uploadObject(attachment, where, document.bytes);
  await recordUpload(space, project, {
    key: where,
    hash: await hash(document.bytes),
    size: document.bytes.length,
    at: new Date().toISOString(),
    etag,
  });
  return {
    name: document.name,
    size: document.bytes.length,
    where: `${attachment.config.prefix}${where}`,
  };
}

/**
 * Record the workspace's document as a revision, then upload it if a bucket is attached. One action,
 * because it is one idea: the revision is the durability, the upload is the copy off this machine.
 */
export async function commitAndUpload(
  space: Directory,
  project: string,
): Promise<CommitResult> {
  const meta = await readMeta(space, project);
  if (!meta) throw new Error("this workspace has no meta.json");
  // Two answers to "is there something to commit?": the badge the row shows (`meta.dirty`, which
  // `inspect` wrote from the document's size and time) and the Changes panel's exact object diff
  // (`pendingChange`). Either saying yes is enough, so the badge the button was pressed on clears.
  const change = await pendingChange(space, project, meta);
  const committed = meta.dirty || change !== null;
  const after: Meta = committed ? await commit(space, project) : meta;
  // Uploading an unchanged document is still worth doing: the bucket copy may be missing or older.
  const uploaded = (await readAttachment(space, project))
    ? await uploadDocument(space, project)
    : null;
  return { committed, rev: after.rev, uploaded };
}

/** Save the workspace's document to this computer, one save back with `previous`. */
export async function downloadWorkspace(
  space: Directory,
  project: string,
  previous = false,
  document?: string,
): Promise<string> {
  const found = await documentBytes(space, project, previous, document);
  if (!found) throw new Error("there is nothing to download");
  saveBytes(found.name, found.bytes);
  return found.name;
}

/**
 * Save every document in the workspace to this computer, as one zip named after the workspace.
 *
 * The documents are stored uncompressed: they are already compressed, so the archive costs one pass
 * over the bytes and nothing else.
 */
export async function downloadWorkspaceFiles(
  space: Directory,
  project: string,
): Promise<string> {
  const files = await documentFiles(space, project);
  if (!files.length) throw new Error("there is nothing to download");
  const meta = await readMeta(space, project);
  const name = `${archiveName(meta?.name ?? project)}.zip`;
  saveBytes(name, zip(files));
  return name;
}

/** A workspace name as a file name: the separators and reserved characters a download cannot carry. */
function archiveName(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, " ")
      .trim() || "workspace"
  );
}

/** Hand bytes to the browser as a download. */
export function saveBytes(name: string, bytes: Uint8Array) {
  const url = URL.createObjectURL(
    new Blob([bytes as BlobPart], { type: "application/octet-stream" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // The download keeps its own reference; revoking now would cancel it.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
