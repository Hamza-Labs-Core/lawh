import { describe, expect, it } from 'vitest';
import { readBridgeMessage } from '../../src/ui/bridgeHost';

const frame = {};
const read = (data: unknown, source: unknown = frame, of: unknown = frame) => readBridgeMessage({ source, data }, of);
const item = (change: object = {}) => ({ id: 'a', title: 'A', level: 1, ...change });

describe('messages from a page', () => {
  it('takes the three kinds, copying only known fields', () => {
    expect(read({ type: 'lawh:outline', items: [item({ html: '<b>' })], answer: 'x' })).toEqual({ type: 'outline', items: [item()] });
    expect(read({ type: 'lawh:open-link', url: 'https://example.com/a' })).toEqual({ type: 'open-link', url: 'https://example.com/a' });
    expect(read({ type: 'lawh:scroll-state', top: 0, height: 5, view: 2 })).toEqual({ type: 'scroll-state', top: 0, height: 5, view: 2 });
  });

  it('takes none from another window, or without a frame', () => {
    const message = { type: 'lawh:scroll-state', top: 0, height: 5, view: 2 };
    for (const [source, of] of [[{}, frame], [null, frame], [undefined, undefined], [null, null]] as const) expect(readBridgeMessage({ source, data: message }, of)).toBeNull();
  });

  it.each([
    null, undefined, 1, 'lawh:outline', [], {}, { type: 'outline', items: [] }, { type: 'lawh:answer', option: 'a' }, { type: 'lawh:comment', body: 'x' }, { type: 'lawh:open-media', src: 'x' },
    { type: 'lawh:outline' }, { type: 'lawh:outline', items: {} }, { type: 'lawh:outline', items: Array.from({ length: 201 }, () => item()) }, { type: 'lawh:outline', items: [null] }, { type: 'lawh:outline', items: new Array(5) }, { type: 'lawh:open-link', url: `https://example.com/${'ب'.repeat(900)}` },
    ...[{ id: '' }, { id: 1 }, { id: 'x'.repeat(201) }, { title: '' }, { title: {} }, { title: 'x'.repeat(201) }, { level: 0 }, { level: 5 }, { level: '1' }].map((change) => ({ type: 'lawh:outline', items: [item(change)] })),
    ...['http://example.com', 'javascript:alert(1)', 'data:text/html,x', 'file:///x', 'https://user@example.com', 'https://a:b@example.com', '/x', '', 1, null, `https://example.com/${'x'.repeat(2000)}`]
      .map((url) => ({ type: 'lawh:open-link', url })),
    ...[{ top: -1 }, { top: Number.NaN }, { top: Infinity }, { height: '5' }, { view: 1e9 }, { view: undefined }].map((change) => ({ type: 'lawh:scroll-state', top: 0, height: 5, view: 2, ...change })),
  ])('refuses %j', (data) => { expect(read(data)).toBeNull(); });
});
