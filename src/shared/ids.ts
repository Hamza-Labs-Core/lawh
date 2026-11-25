const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A prefixed ULID: 48 bits of time, 80 random bits. */
export function newId(prefix: string, now = Date.now()): string {
  let time = '';
  for (let i = 0, t = now; i < 10; i++, t = Math.floor(t / 32)) time = ALPHABET[t % 32] + time;
  const random = crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}_${time}${Array.from(random, (byte) => ALPHABET[byte % 32]).join('')}`;
}
