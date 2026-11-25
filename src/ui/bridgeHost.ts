/**
 * The app's side of the bridge. The page can forge every message, so each is checked and copied field by field, and
 * none can do more than move the app's own view: no message answers a decision, writes a comment or calls the API.
 */
export type BridgeMessage =
  | { type: 'outline'; items: { id: string; title: string; level: number }[] }
  | { type: 'open-link'; url: string }
  | { type: 'scroll-state'; top: number; height: number; view: number }
  | Media;

export type Picture = { kind: 'image'; path: string } | { kind: 'svg'; text: string; width: number; height: number } | { kind: 'bitmap'; bitmap: ImageBitmap } | { kind: 'none' };
/** asked: an answer to the viewer's arrows, not something that was pressed in the page. */
export interface Media { type: 'open-media'; asked: boolean; index: number; total: number; label: string; background: string; picture: Picture }

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isSize = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e8;

const isBitmap = (value: unknown): value is ImageBitmap => typeof ImageBitmap !== 'undefined' && value instanceof ImageBitmap;

/** Frees the pixels of a picture that won't be shown: they are the browser's memory, not only this page's. */
export function discard(picture: Picture): void { if (picture.kind === 'bitmap') picture.bitmap.close(); }

export function readBridgeMessage(event: { source: unknown; data: unknown }, frame: unknown): BridgeMessage | null {
  if (!isObject(event.data)) return null;
  const message = frame && event.source === frame ? read(event.data) : null;
  const kept = message?.type === 'open-media' && message.picture.kind === 'bitmap' ? message.picture.bitmap : null;
  // Also one sent along with a message that has no use for it.
  if (isBitmap(event.data.bitmap) && event.data.bitmap !== kept) event.data.bitmap.close();
  return message;
}

function read(data: Record<string, unknown>): BridgeMessage | null {
  switch (data.type) {
    case 'lawh:outline': {
      if (!Array.isArray(data.items) || data.items.length > 200) return null;
      const items: { id: string; title: string; level: number }[] = [];
      // By index: a list can come with holes, which map() skips.
      for (let i = 0; i < data.items.length; i++) {
        const item: unknown = data.items[i];
        if (!isObject(item) || typeof item.id !== 'string' || item.id.length < 1 || item.id.length > 200 || typeof item.title !== 'string' || item.title.length < 1
          || item.title.length > 200 || typeof item.level !== 'number' || ![1, 2, 3, 4].includes(item.level)) return null;
        items.push({ id: item.id, title: item.title, level: item.level });
      }
      return { type: 'outline', items };
    }
    case 'lawh:open-link': {
      if (typeof data.url !== 'string' || data.url.length > 2000) return null;
      try {
        const url = new URL(data.url);
        // No user name or password: they can make an address look like another site's.
        return url.protocol === 'https:' && !url.username && !url.password && url.href.length <= 2000 ? { type: 'open-link', url: url.href } : null;
      } catch { return null; }
    }
    case 'lawh:scroll-state':
      return isSize(data.top) && isSize(data.height) && isSize(data.view) ? { type: 'scroll-state', top: data.top, height: data.height, view: data.view } : null;
    case 'lawh:open-media': {
      const { index, total, label, background } = data;
      if (typeof index !== 'number' || typeof total !== 'number' || !Number.isInteger(index) || !Number.isInteger(total) || index < 0 || index >= total || total > 500) return null;
      if (typeof label !== 'string' || label.length > 200 || typeof background !== 'string' || !/^rgba?\([\d., %/]{1,40}\)$/.test(background)) return null;
      const picture = readPicture(data);
      return picture && { type: 'open-media', asked: data.asked === true, index, total, label, background, picture };
    }
    default:
      return null;
  }
}

const MAX_SVG = 5_000_000, MAX_SIDE = 16_384;

/** What a page wants shown. It goes to the viewer's frame only; the app itself never turns it into an address or markup. */
function readPicture(data: Record<string, unknown>): Picture | null {
  switch (data.kind) {
    case 'image':
      // A file of this version, as published paths are: the viewer asks the content host for it with the version's own token.
      return typeof data.path === 'string' && data.path.length >= 1 && data.path.length <= 512 && data.path.split('/').every((part) => part !== '' && part !== '.' && part !== '..') && !data.path.startsWith('_lawh/')
        ? { kind: 'image', path: data.path } : null;
    case 'svg':
      return typeof data.text === 'string' && data.text.length <= MAX_SVG && isSize(data.width) && isSize(data.height) ? { kind: 'svg', text: data.text, width: data.width, height: data.height } : null;
    case 'bitmap':
      return isBitmap(data.bitmap) && data.bitmap.width > 0 && data.bitmap.height > 0 && data.bitmap.width <= MAX_SIDE && data.bitmap.height <= MAX_SIDE ? { kind: 'bitmap', bitmap: data.bitmap } : null;
    case 'none':
      return { kind: 'none' };
    default:
      return null;
  }
}

export type ViewerMessage = 'ready' | { done: 'shown' | 'failed'; id: number } | Act;
export type Act = 'close' | 'next' | 'previous' | 'in' | 'out' | 'fit';

/** What the viewer's frame may tell: that it is ready or failed, and the keys a person presses there. `rtl`: arrows are mirrored. */
export function readViewerMessage(event: { source: unknown; data: unknown }, frame: unknown, rtl: boolean): ViewerMessage | null {
  if (!frame || event.source !== frame || !isObject(event.data)) return null;
  const { type, key, id } = event.data;
  if (type === 'lawh:viewer-ready') return 'ready';
  if ((type === 'lawh:viewer-shown' || type === 'lawh:viewer-failed') && typeof id === 'number') return { done: type === 'lawh:viewer-shown' ? 'shown' : 'failed', id };
  return type === 'lawh:key' && typeof key === 'string' ? viewerKey(key, rtl) : null;
}

/** What a key does in the viewer; the same whether it is pressed there or in the app around it. */
export function viewerKey(key: string, rtl: boolean): Act | null {
  switch (key) {
    case 'Escape': return 'close';
    case 'ArrowRight': return rtl ? 'previous' : 'next';
    case 'ArrowLeft': return rtl ? 'next' : 'previous';
    case 'ArrowDown': return 'next';
    case 'ArrowUp': return 'previous';
    case '+': case '=': return 'in';
    case '-': return 'out';
    case '0': return 'fit';
    default: return null;
  }
}
