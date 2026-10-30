/**
 * What can be done to a workspace's bytes from outside an editor: send the document to its bucket, or
 * take it away to this computer. Versions are recorded on save (see `session.refresh`), so nothing here
 * commits.
 *
 * Design: [Design Rules](../…/docs/atelier_web_design.md) — the bucket is the copy that is not this
 * machine. Everything here signs in the browser, so no server sees a credential.
 */
import { readAttachment, uploadObject } from "./bucket";
import {
  documentBytes,
  documentFiles,
  hash,
  objectKey,
  readDocument,
  readMeta,
  recordUpload,
} from "./contract";
import type { Directory } from "./opfs";
import { zip } from "./zip";

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

/** Save one document of the workspace to this computer, the recorded one when none is named. */
export async function downloadWorkspace(
  space: Directory,
  project: string,
  document?: string,
): Promise<string> {
  const found = await documentBytes(space, project, document);
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
