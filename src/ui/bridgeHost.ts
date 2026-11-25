/**
 * The app's side of the bridge. The page can forge every message, so each is checked and copied field by field, and
 * none can do more than move the app's own view: no message answers a decision, writes a comment or calls the API.
 */
export type BridgeMessage =
  | { type: 'outline'; items: { id: string; title: string; level: number }[] }
  | { type: 'open-link'; url: string }
  | { type: 'scroll-state'; top: number; height: number; view: number };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isSize = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e8;

export function readBridgeMessage(event: { source: unknown; data: unknown }, frame: unknown): BridgeMessage | null {
  if (!frame || event.source !== frame || !isObject(event.data)) return null;
  const { data } = event;
  switch (data.type) {
    case 'lawh:outline': {
      if (!Array.isArray(data.items) || data.items.length > 200) return null;
      const items = data.items.map((item: unknown) =>
        isObject(item) && typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 200 && typeof item.title === 'string' && item.title.length > 0 && item.title.length <= 200
          && typeof item.level === 'number' && [1, 2, 3, 4].includes(item.level) ? { id: item.id, title: item.title, level: item.level } : null);
      return items.includes(null) ? null : { type: 'outline', items: items as { id: string; title: string; level: number }[] };
    }
    case 'lawh:open-link': {
      if (typeof data.url !== 'string' || data.url.length > 2000) return null;
      try {
        const url = new URL(data.url);
        // No user name or password: they can make an address look like another site's.
        return url.protocol === 'https:' && !url.username && !url.password ? { type: 'open-link', url: url.href } : null;
      } catch { return null; }
    }
    case 'lawh:scroll-state':
      return isSize(data.top) && isSize(data.height) && isSize(data.view) ? { type: 'scroll-state', top: data.top, height: data.height, view: data.view } : null;
    default:
      return null;
  }
}
