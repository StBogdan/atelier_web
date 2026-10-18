/**
 * A ZIP writer for the workspace download: the files go in as they are, with no compression.
 *
 * Every document here is already compressed — PSB and PSD hold compressed channels, PNG holds
 * deflated scanlines, and `.pcraft` is itself a ZIP — so deflating them again would spend time to
 * save nearly nothing. Stored entries also keep the download of a large document to one pass over
 * its bytes.
 */

/** One file in the archive. */
export interface ZipFile {
  name: string;
  bytes: Uint8Array;
  /** The file's `File.lastModified`, which becomes the entry's timestamp. */
  modified?: number;
}

const FLAG_UTF8 = 0x0800;
const STORED = 0;
const VERSION = 20;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let bit = 0; bit < 8; bit++)
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++)
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS time and date, in the two 16-bit words the format stores: seconds count in twos. */
function dosDateTime(modified: number): { time: number; date: number } {
  const at = new Date(modified);
  const year = Math.max(1980, at.getFullYear());
  return {
    time:
      (at.getHours() << 11) |
      (at.getMinutes() << 5) |
      (Math.floor(at.getSeconds() / 2) & 0x1f),
    date: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
  };
}

/** The archive, as the bytes to hand the browser's download. */
export function zip(files: ZipFile[]): Uint8Array {
  if (files.length > 0xffff)
    throw new Error("this workspace holds too many files for one download");
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const records: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    if (file.bytes.length > 0xffffffff)
      throw new Error(`${file.name} is too large for one download`);
    const name = encoder.encode(file.name);
    const crc = crc32(file.bytes);
    const { time, date } = dosDateTime(file.modified ?? Date.now());

    const local = new Uint8Array(30 + name.length);
    const header = new DataView(local.buffer);
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, VERSION, true);
    header.setUint16(6, FLAG_UTF8, true);
    header.setUint16(8, STORED, true);
    header.setUint16(10, time, true);
    header.setUint16(12, date, true);
    header.setUint32(14, crc, true);
    header.setUint32(18, file.bytes.length, true);
    header.setUint32(22, file.bytes.length, true);
    header.setUint16(26, name.length, true);
    header.setUint16(28, 0, true);
    local.set(name, 30);

    const record = new Uint8Array(46 + name.length);
    const entry = new DataView(record.buffer);
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, VERSION, true);
    entry.setUint16(6, VERSION, true);
    entry.setUint16(8, FLAG_UTF8, true);
    entry.setUint16(10, STORED, true);
    entry.setUint16(12, time, true);
    entry.setUint16(14, date, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, file.bytes.length, true);
    entry.setUint32(24, file.bytes.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint16(30, 0, true);
    entry.setUint16(32, 0, true);
    entry.setUint16(34, 0, true);
    entry.setUint16(36, 0, true);
    entry.setUint32(38, 0, true);
    entry.setUint32(42, offset, true);
    record.set(name, 46);

    locals.push(local, file.bytes);
    records.push(record);
    offset += local.length + file.bytes.length;
  }

  const directory = records.reduce((total, record) => total + record.length, 0);
  const end = new Uint8Array(22);
  const tail = new DataView(end.buffer);
  tail.setUint32(0, 0x06054b50, true);
  tail.setUint16(4, 0, true);
  tail.setUint16(6, 0, true);
  tail.setUint16(8, files.length, true);
  tail.setUint16(10, files.length, true);
  tail.setUint32(12, directory, true);
  tail.setUint32(16, offset, true);
  tail.setUint16(20, 0, true);

  const archive = new Uint8Array(offset + directory + end.length);
  let at = 0;
  for (const part of [...locals, ...records, end]) {
    archive.set(part, at);
    at += part.length;
  }
  return archive;
}
