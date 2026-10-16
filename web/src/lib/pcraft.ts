/**
 * A `.pcraft` is a ZIP in STORE mode whose entry names are the BLAKE3 hashes of their contents
 * (design, Delta Sync). Two things follow, and both matter here:
 *
 * - The object set of a revision is the entry-name set, read from the central directory. No
 *   decompression, no hashing: the numbers in the Changes panel are exact and nearly free
 *   (design, Where Cloud State Is Surfaced).
 * - The entry names *are* the hashes, so the provider never computes BLAKE3 itself.
 */

export interface ZipEntry {
  name: string;
  /** Uncompressed size in bytes. */
  size: number;
  /** Bytes the entry occupies in the file. Equals `size` in STORE mode. */
  stored: number;
  method: number;
  /** Offset of the entry's local file header. */
  headerOffset: number;
}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY = 0x06064b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR = 0x07064b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const ZIP64_EXTRA = 0x0001;

/** Entries that are content-addressed objects: what a revision's delta is computed from (design, Delta Sync). */
const OBJECT_PREFIXES = ["tiles/", "blobs/"];

/** Where the editor puts a document's composited preview; the landing page's thumbnail. */
const PREVIEW_NAMES = ["composite/preview.png", "thumb.png"];

export function isPcraft(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

/** Read the central directory: every entry's name, sizes and where its data starts. */
export function readDirectory(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEndOfCentralDirectory(view);
  if (end < 0) throw new Error("not a ZIP: no end-of-central-directory record");

  let count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  if (count === 0xffff || offset === 0xffffffff) {
    const zipped = zip64Directory(view, end);
    if (zipped) {
      count = zipped.count;
      offset = zipped.offset;
    }
  }

  const entries: ZipEntry[] = [];
  const decoder = new TextDecoder();
  let at = offset;
  for (let i = 0; i < count; i++) {
    if (
      at + 46 > view.byteLength ||
      view.getUint32(at, true) !== CENTRAL_DIRECTORY_HEADER
    )
      break;
    const method = view.getUint16(at + 10, true);
    let stored = view.getUint32(at + 20, true);
    let size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    let headerOffset = view.getUint32(at + 42, true);

    if (
      stored === 0xffffffff ||
      size === 0xffffffff ||
      headerOffset === 0xffffffff
    ) {
      const zip64 = readZip64Extra(view, at + 46 + nameLength, extraLength, [
        stored,
        size,
        headerOffset,
      ]);
      stored = zip64[0];
      size = zip64[1];
      headerOffset = zip64[2];
    }

    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    entries.push({ name, size, stored, method, headerOffset });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndOfCentralDirectory(view: DataView): number {
  const earliest = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let at = view.byteLength - 22; at >= earliest; at--) {
    if (view.getUint32(at, true) === END_OF_CENTRAL_DIRECTORY) return at;
  }
  return -1;
}

function zip64Directory(
  view: DataView,
  end: number,
): { count: number; offset: number } | null {
  const locator = end - 20;
  if (
    locator < 0 ||
    view.getUint32(locator, true) !== ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR
  )
    return null;
  const record = Number(view.getBigUint64(locator + 8, true));
  if (
    record < 0 ||
    record + 56 > view.byteLength ||
    view.getUint32(record, true) !== ZIP64_END_OF_CENTRAL_DIRECTORY
  )
    return null;
  return {
    count: Number(view.getBigUint64(record + 32, true)),
    offset: Number(view.getBigUint64(record + 48, true)),
  };
}

/** The ZIP64 extra field holds only the fields whose 32-bit values were all-ones, in order. */
function readZip64Extra(
  view: DataView,
  start: number,
  length: number,
  fields: number[],
): number[] {
  const out = [...fields];
  let at = start;
  const end = start + length;
  while (at + 4 <= end) {
    const id = view.getUint16(at, true);
    const size = view.getUint16(at + 2, true);
    if (id === ZIP64_EXTRA) {
      let field = at + 4;
      for (let i = 0; i < out.length; i++) {
        if (out[i] !== 0xffffffff || field + 8 > end) continue;
        out[i] = Number(view.getBigUint64(field, true));
        field += 8;
      }
      break;
    }
    at += 4 + size;
  }
  return out;
}

/**
 * The revision's object set: content-addressed entries only, name to size. `manifest.json`, the
 * previews and anything else the format adds are not objects and are not part of the delta.
 */
export function objectSet(entries: ZipEntry[]): Map<string, number> {
  const objects = new Map<string, number>();
  for (const entry of entries) {
    if (OBJECT_PREFIXES.some((prefix) => entry.name.startsWith(prefix)))
      objects.set(entry.name, entry.size);
  }
  return objects;
}

export function previewEntry(entries: ZipEntry[]): ZipEntry | undefined {
  for (const name of PREVIEW_NAMES) {
    const entry = entries.find((candidate) => candidate.name === name);
    if (entry) return entry;
  }
  return undefined;
}

/** An entry's bytes, through `DecompressionStream` when the format used DEFLATE. */
export async function readEntry(
  bytes: Uint8Array,
  entry: ZipEntry,
): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(entry.headerOffset, true) !== LOCAL_FILE_HEADER)
    throw new Error(`${entry.name}: no local file header`);
  const nameLength = view.getUint16(entry.headerOffset + 26, true);
  const extraLength = view.getUint16(entry.headerOffset + 28, true);
  const start = entry.headerOffset + 30 + nameLength + extraLength;
  const stored = bytes.subarray(start, start + entry.stored);
  if (entry.method === 0) return stored;
  if (entry.method !== 8)
    throw new Error(
      `${entry.name}: unsupported compression method ${entry.method}`,
    );
  const stream = new Blob([stored as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface Difference {
  added: ZipEntry[];
  changed: ZipEntry[];
  removed: number;
  unchanged: number;
  unchangedBytes: number;
  bytes: number;
}

/**
 * The difference between the committed revision's object set and the current one, in the terms
 * the Changes panel shows (design, Delta Sync, Where Cloud State Is Surfaced).
 */
export function difference(
  previous: Record<string, number>,
  next: Map<string, number>,
  entries: ZipEntry[],
): Difference {
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const added: ZipEntry[] = [];
  const changed: ZipEntry[] = [];
  let bytes = 0;
  let unchanged = 0;
  let unchangedBytes = 0;
  for (const [name, size] of next) {
    const before = previous[name];
    if (before === undefined) {
      added.push(
        byName.get(name) ?? {
          name,
          size,
          stored: size,
          method: 0,
          headerOffset: 0,
        },
      );
      bytes += size;
    } else if (before !== size) {
      changed.push(
        byName.get(name) ?? {
          name,
          size,
          stored: size,
          method: 0,
          headerOffset: 0,
        },
      );
      bytes += size;
    } else {
      unchanged++;
      unchangedBytes += size;
    }
  }
  let removed = 0;
  for (const name of Object.keys(previous)) if (!next.has(name)) removed++;
  return { added, changed, removed, unchanged, unchangedBytes, bytes };
}
