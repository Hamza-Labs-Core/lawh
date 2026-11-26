/** A ZIP file written as a stream: nothing is compressed, and nothing is held whole. */

const TABLE = Uint32Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });

export function crc32(bytes: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]!) & 255]! ^ (c >>> 8);
  return ~c >>> 0;
}

const MAX32 = 0xFFFFFFFF;

/** `size` bytes, filled with little-endian numbers of 2, 4 or 8 bytes. */
function pack(...fields: [size: 2 | 4 | 8, value: number][]): Uint8Array {
  const out = new Uint8Array(fields.reduce((n, [size]) => n + size, 0)), view = new DataView(out.buffer);
  let at = 0;
  for (const [size, value] of fields) {
    if (size === 2) view.setUint16(at, value, true); else if (size === 4) view.setUint32(at, value, true); else view.setBigUint64(at, BigInt(value), true);
    at += size;
  }
  return out;
}

export interface Entry { name: string; body: AsyncIterable<Uint8Array> }

// ZIP64 local extra placeholder so streaming data descriptors always use 8-byte sizes (APPNOTE §4.3.9.2).
const LFH_ZIP64 = pack([2, 1], [2, 16], [8, 0], [8, 0]);

/** Build a central directory entry (ZIP64 extra field whenever size or offset reaches 4 GiB). */
export function centralEntry(encoded: Uint8Array, crc: number, size: number, offset: number): [Uint8Array, Uint8Array, Uint8Array] {
  const big = size >= MAX32, far = offset >= MAX32;
  const fields: [size: 2 | 4 | 8, value: number][] = [];
  if (big) fields.push([8, size], [8, size]);
  if (far) fields.push([8, offset]);
  const extra = fields.length > 0 ? pack([2, 1], [2, fields.length * 8], ...fields) : new Uint8Array();
  const header = pack(
    [4, 0x02014b50], [2, 45], [2, 45], [2, 0x0808], [2, 0], [2, 0], [2, 0x21],
    [4, crc], [4, big ? MAX32 : size], [4, big ? MAX32 : size], [2, encoded.length], [2, extra.length],
    [2, 0], [2, 0], [2, 0], [4, 0], [4, far ? MAX32 : offset],
  );
  return [header, encoded, extra];
}

/** Streams a valid ZIP64 archive of arbitrary entry sizes and archive size. */
export async function* zip(entries: AsyncIterable<Entry>): AsyncGenerator<Uint8Array> {
  const directory: Uint8Array[] = [];
  let at = 0;
  for await (const { name, body } of entries) {
    const encoded = new TextEncoder().encode(name), offset = at;
    if (encoded.length > 0xFFFF) throw new RangeError('ZIP entry name is too long.');
    // Bits 3 and 11: sizes follow in the ZIP64 data descriptor, and the name is UTF-8. Time is 1980-01-01.
    const head = pack([4, 0x04034b50], [2, 45], [2, 0x0808], [2, 0], [2, 0], [2, 0x21], [4, 0], [4, 0], [4, 0], [2, encoded.length], [2, LFH_ZIP64.length]);
    yield head; yield encoded; yield LFH_ZIP64;
    at += head.length + encoded.length + LFH_ZIP64.length;
    let crc = 0, size = 0;
    for await (const chunk of body) { crc = crc32(chunk, crc); size += chunk.length; yield chunk; }
    const tail = pack([4, 0x08074b50], [4, crc], [8, size], [8, size]);
    yield tail;
    at += size + tail.length;
    directory.push(...centralEntry(encoded, crc, size, offset));
  }
  const start = at, size = directory.reduce((n, part) => n + part.length, 0), count = directory.length / 3;
  yield* directory;
  at += size;
  if (count >= 0xFFFF || start >= MAX32 || size >= MAX32) {
    yield pack([4, 0x06064b50], [8, 44], [2, 45], [2, 45], [4, 0], [4, 0], [8, count], [8, count], [8, size], [8, start]);
    yield pack([4, 0x07064b50], [4, 0], [8, at], [4, 1]);
  }
  yield pack([4, 0x06054b50], [2, 0], [2, 0], [2, Math.min(count, 0xFFFF)], [2, Math.min(count, 0xFFFF)], [4, Math.min(size, MAX32)], [4, Math.min(start, MAX32)], [2, 0]);
}
