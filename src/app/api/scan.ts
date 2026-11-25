import { ApiError } from '../../shared/errors';

// Shapes of common credentials. Each must be recognizable within OVERLAP characters.
const SECRET = new RegExp([
  'lawh_key_[0-9A-HJKMNP-TV-Z]{26}_[A-Za-z0-9_-]{43}',
  '-----BEGIN [A-Z ]{0,30}PRIVATE KEY-----',
  '\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b',
  '\\bgh[pousr]_[A-Za-z0-9]{36}',
  '\\bgithub_pat_[A-Za-z0-9_]{60}',
  '\\bglpat-[A-Za-z0-9_-]{20}',
  '\\bxox[abeprs]-[A-Za-z0-9-]{20}',
  '\\bAIza[0-9A-Za-z_-]{35}',
  '\\bsk-ant-[A-Za-z0-9_-]{24}',
  '\\bsk-proj-[A-Za-z0-9_-]{24}',
  '\\bnpm_[A-Za-z0-9]{36}\\b',
  '\\bSG\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}',
].join('|'));
const OVERLAP = 256;

export const findSecret = (text: string): number => SECRET.exec(text)?.index ?? -1;

/** Passes bytes through, and fails with the position of anything that looks like a key. Holds one chunk at a time. */
export function secretScanner(): TransformStream<Uint8Array, Uint8Array> {
  // One character for each byte, so positions are byte positions whatever the file is.
  const decoder = new TextDecoder('latin1');
  let tail = '', seen = 0;
  return new TransformStream({
    transform(chunk, controller) {
      const window = tail + decoder.decode(chunk);
      const at = findSecret(window);
      if (at !== -1) throw new ApiError('secret_found', 'The file looks like it has a key or password in it.', { position: seen - tail.length + at });
      seen += chunk.byteLength;
      tail = window.slice(-OVERLAP);
      controller.enqueue(chunk);
    },
  });
}
