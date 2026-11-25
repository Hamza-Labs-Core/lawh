import { invalid } from '../../shared/errors';

// No PDF: the sandbox blocks PDF viewers. The type comes from here, never from the uploader.
const MEDIA_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8', csv: 'text/csv; charset=utf-8', txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8', xml: 'application/xml; charset=utf-8', svg: 'image/svg+xml; charset=utf-8',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', wasm: 'application/wasm',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm',
};

export const isHtml = (path: string): boolean => /\.html?$/i.test(path);

export function checkPath(path: unknown): string {
  const bad = typeof path !== 'string' || path.length === 0 || path.length > 512 || !path.isWellFormed() || path.normalize('NFC') !== path
    // eslint-disable-next-line no-control-regex
    || /[\\\u0000-\u001F\u007F]/.test(path)
    || path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
    || /^_lawh(\/|$)/i.test(path);
  if (bad) throw invalid('A file path must be relative, in NFC, with no empty, "." or ".." part, no backslash, and not under _lawh/.');
  return path;
}

export function mediaType(path: string): string {
  const type = MEDIA_TYPES[/\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? ''];
  if (!type) throw invalid('A file has a type that pages can\'t use.', { path });
  return type;
}
