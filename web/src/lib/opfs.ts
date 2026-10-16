/**
 * The Origin Private File System itself: handles, bytes, directory entries. The contract — what
 * lives where, who writes it, how the two apps coordinate — is `contract.ts`.
 *
 * Everything here is async: the synchronous OPFS API (`createSyncAccessHandle`) is Worker-only
 * (design, Architectural Consequences), and this app runs on the main thread next to the editor's page.
 */

export const SPACE = "atelier-cloud";

export type Directory = FileSystemDirectoryHandle;

/**
 * The asynchronous directory iterators. Every browser that has OPFS has them; the TypeScript DOM
 * lib this project compiles against does not declare them yet.
 */
interface IterableDirectory extends FileSystemDirectoryHandle {
  keys(): AsyncIterableIterator<string>;
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
}

export async function opfs(): Promise<Directory> {
  return await navigator.storage.getDirectory();
}

export function opfsAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.storage?.getDirectory === "function"
  );
}

export async function directory(
  parent: Directory,
  name: string,
  create = false,
): Promise<Directory> {
  return create
    ? await parent.getDirectoryHandle(name, { create: true })
    : await parent.getDirectoryHandle(name);
}

/** Whether `name` is a directory in `parent` (a `getDirectoryHandle` that throws means no). */
export async function hasDirectory(
  parent: Directory,
  name: string,
): Promise<boolean> {
  try {
    await parent.getDirectoryHandle(name);
    return true;
  } catch {
    return false;
  }
}

/** The names of the *files* in `parent`: directories are not files, whatever their extension. */
export async function files(parent: Directory): Promise<string[]> {
  const names: string[] = [];
  for await (const [name, handle] of (parent as IterableDirectory).entries()) {
    if (handle.kind === "file") names.push(name);
  }
  return names.sort();
}

export async function subdirectories(parent: Directory): Promise<string[]> {
  const names: string[] = [];
  for await (const [name, handle] of (parent as IterableDirectory).entries()) {
    if (handle.kind === "directory") names.push(name);
  }
  return names.sort();
}

export async function stat(
  parent: Directory,
  name: string,
): Promise<{ size: number; modified: number } | null> {
  try {
    const file = await (await parent.getFileHandle(name)).getFile();
    return { size: file.size, modified: file.lastModified };
  } catch {
    return null;
  }
}

export async function readBytes(
  parent: Directory,
  name: string,
): Promise<Uint8Array> {
  const file = await (await parent.getFileHandle(name)).getFile();
  return new Uint8Array(await file.arrayBuffer());
}

export async function readText(
  parent: Directory,
  name: string,
): Promise<string> {
  return new TextDecoder().decode(await readBytes(parent, name));
}

/**
 * The JSON in `name`, or `null` when there is none to read.
 *
 * A file being replaced is truncated before its new bytes land, so a reader that arrives inside a
 * write fails with `NotReadableError`, or parses an empty or half-written file and throws
 * `SyntaxError`. Neither means the file is missing or broken: the bytes are not there *yet*, and one
 * retry, after the writer has closed, reads them. A file that is really gone still answers `null`.
 */
export async function readJson<T>(
  parent: Directory,
  name: string,
): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      return JSON.parse(await readText(parent, name)) as T;
    } catch (error) {
      const midWrite =
        error instanceof SyntaxError ||
        (error instanceof DOMException && error.name === "NotReadableError");
      if (attempt > 0 || !midWrite) return null;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

/**
 * The bytes to hand `write()`.
 *
 * WebKit's `FileSystemWritableFileStream.write()` writes the whole backing `ArrayBuffer` of a
 * `Uint8Array` and ignores the view, so a 250-byte slice of a 1000-byte buffer lands all 1000 bytes
 * in the file. A slice of a document (`readEntry`, for the thumbnail) would put the whole document
 * in `thumb.png`. A buffer that already *is* the bytes is immune, so only a view is copied.
 */
function wholeBuffer(bytes: Uint8Array): Uint8Array {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes
    : bytes.slice();
}

export async function writeBytes(
  parent: Directory,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  const handle = await parent.getFileHandle(name, { create: true });
  const stream = await handle.createWritable();
  try {
    await stream.write(wholeBuffer(bytes) as BufferSource);
  } finally {
    await stream.close();
  }
}

export async function writeText(
  parent: Directory,
  name: string,
  text: string,
): Promise<void> {
  await writeBytes(parent, name, new TextEncoder().encode(text));
}

export async function writeJson(
  parent: Directory,
  name: string,
  value: unknown,
): Promise<void> {
  await writeText(parent, name, JSON.stringify(value, null, 2) + "\n");
}

export async function remove(
  parent: Directory,
  name: string,
  recursive = false,
): Promise<void> {
  await parent.removeEntry(name, { recursive });
}

/** `atelier-cloud:project:<id>` (design, Coordination Primitives): the same name the editor's patch requests. */
export function lockName(project: string): string {
  return `${SPACE}:project:${project}`;
}

/**
 * Hold a lock across `action`. Readers take `shared`, writers `exclusive`, so a read can never
 * catch the editor's swap half-finished (design, Saving).
 */
export function withLock<T>(
  name: string,
  mode: LockMode,
  action: () => Promise<T>,
): Promise<T> {
  return navigator.locks.request(name, { mode }, action) as Promise<T>;
}
