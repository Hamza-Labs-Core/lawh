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

/** Each entry must be smaller than 4 GB; the whole may be larger. */
export async function* zip(entries: AsyncIterable<Entry>): AsyncGenerator<Uint8Array> {
  const directory: Uint8Array[] = [];
  let at = 0;
  for await (const { name, body } of entries) {
    const encoded = new TextEncoder().encode(name), offset = at;
    // Bits 3 and 11: the sizes come after the data, and the name is UTF-8. The time is 1980-01-01, for no reason to tell another.
    const head = pack([4, 0x04034b50], [2, 45], [2, 0x0808], [2, 0], [2, 0], [2, 0x21], [4, 0], [4, 0], [4, 0], [2, encoded.length], [2, 0]);
    yield head; yield encoded;
    at += head.length + encoded.length;
    let crc = 0, size = 0;
    for await (const chunk of body) { crc = crc32(chunk, crc); size += chunk.length; yield chunk; }
    const tail = pack([4, 0x08074b50], [4, crc], [4, size], [4, size]);
    yield tail;
    at += size + tail.length;
    const far = offset >= MAX32, extra = far ? pack([2, 1], [2, 8], [8, offset]) : new Uint8Array();
    directory.push(pack([4, 0x02014b50], [2, 45], [2, 45], [2, 0x0808], [2, 0], [2, 0], [2, 0x21], [4, crc], [4, size], [4, size], [2, encoded.length], [2, extra.length], [2, 0], [2, 0], [2, 0], [4, 0], [4, far ? MAX32 : offset]), encoded, extra);
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
