import { describe, expect, it } from 'vitest';
import { readBridgeMessage, readViewerMessage, viewerKey } from '../../src/ui/bridgeHost';

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
    ...[{ index: 2 }, { index: -1 }, { index: 0.5 }, { total: 501 }, { total: '2' }, { label: 1 }, { label: 'x'.repeat(201) }, { background: 'red' }, { background: 'url(https://example.com)' }, { background: 'rgb(0,0,0); color: red' }, { kind: 'html' }, { kind: undefined }]
      .map((change) => ({ type: 'lawh:open-media', index: 0, total: 2, label: '', background: 'rgb(0, 0, 0)', kind: 'none', ...change })),
    ...['', '/a.png', 'a//b.png', '../a.png', 'a/./b', '_lawh/viewer', 'x'.repeat(513), 5].map((path) => ({ type: 'lawh:open-media', index: 0, total: 1, label: '', background: 'rgb(0, 0, 0)', kind: 'image', path })),
    ...[{ text: 'x'.repeat(5_000_001) }, { text: 5 }, { width: -1 }, { height: Number.NaN }].map((change) => ({ type: 'lawh:open-media', index: 0, total: 1, label: '', background: 'rgb(0, 0, 0)', kind: 'svg', text: '<svg/>', width: 1, height: 1, ...change })),
    { type: 'lawh:open-media', index: 0, total: 1, label: '', background: 'rgb(0, 0, 0)', kind: 'bitmap', bitmap: {} },
    { type: 'lawh:outline' }, { type: 'lawh:outline', items: {} }, { type: 'lawh:outline', items: Array.from({ length: 201 }, () => item()) }, { type: 'lawh:outline', items: [null] }, { type: 'lawh:outline', items: new Array(5) }, { type: 'lawh:open-link', url: `https://example.com/${'ب'.repeat(900)}` },
    ...[{ id: '' }, { id: 1 }, { id: 'x'.repeat(201) }, { title: '' }, { title: {} }, { title: 'x'.repeat(201) }, { level: 0 }, { level: 5 }, { level: '1' }].map((change) => ({ type: 'lawh:outline', items: [item(change)] })),
    ...['http://example.com', 'javascript:alert(1)', 'data:text/html,x', 'file:///x', 'https://user@example.com', 'https://a:b@example.com', '/x', '', 1, null, `https://example.com/${'x'.repeat(2000)}`]
      .map((url) => ({ type: 'lawh:open-link', url })),
    ...[{ top: -1 }, { top: Number.NaN }, { top: Infinity }, { height: '5' }, { view: 1e9 }, { view: undefined }].map((change) => ({ type: 'lawh:scroll-state', top: 0, height: 5, view: 2, ...change })),
  ])('refuses %j', (data) => { expect(read(data)).toBeNull(); });
});

describe('pictures', () => {
  const media = (picture: object) => read({ type: 'lawh:open-media', index: 1, total: 2, label: 'L', background: 'rgba(0, 0, 0, 0.5)', html: 'x', ...picture });
  it.each([
    [{ kind: 'image', path: 'a b/صورة.png', more: 1 }, { kind: 'image', path: 'a b/صورة.png' }],
    [{ kind: 'svg', text: '<svg/>', width: 1, height: 2, more: 1 }, { kind: 'svg', text: '<svg/>', width: 1, height: 2 }],
    [{ kind: 'none', more: 1 }, { kind: 'none' }],
  ])('copies only what it knows: %j', (data, picture) => {
    expect(media(data)).toEqual({ type: 'open-media', index: 1, total: 2, label: 'L', background: 'rgba(0, 0, 0, 0.5)', picture });
  });
});

describe('messages from the viewer', () => {
  const from = (data: unknown, source: unknown = frame, rtl = false) => readViewerMessage({ source, data }, frame, rtl);
  it('takes readiness, results and the keys it knows, and nothing else', () => {
    expect([from({ type: 'lawh:viewer-ready' }), from({ type: 'lawh:viewer-shown' }), from({ type: 'lawh:viewer-failed' })]).toEqual(['ready', 'shown', 'failed']);
    expect(['Escape', 'ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', '+', '=', '-', '0'].map((key) => from({ type: 'lawh:key', key }))).toEqual(['close', 'next', 'previous', 'next', 'previous', 'in', 'in', 'out', 'fit']);
    for (const data of [null, {}, 'x', { type: 'lawh:key' }, { type: 'lawh:key', key: 'Enter' }, { type: 'lawh:key', key: 5 }, { type: 'lawh:open-link', url: 'https://example.com' }, { type: 'answer' }]) expect(from(data)).toBeNull();
  });
  it('takes none from another window', () => { for (const source of [{}, null, undefined]) expect(readViewerMessage({ source, data: { type: 'lawh:key', key: 'Escape' } }, frame, false)).toBeNull(); });
  it('mirrors the side arrows in Arabic', () => {
    expect([viewerKey('ArrowRight', true), viewerKey('ArrowLeft', true), viewerKey('ArrowDown', true)]).toEqual(['previous', 'next', 'next']);
  });
});
