import { ENTITIES, LEGACY_ENTITIES } from './entities';

/** Text as it is indexed and as it is searched: the same on both sides. */

const MAX_BYTES = 200_000, MAX_HTML = 3_000_000;
const encoder = new TextEncoder(), decoder = new TextDecoder();

/** No diacritics, one form of each Arabic letter that people write in several ways, Western digits. The index itself folds case and Latin accents. */
export function normalize(text: string): string {
  return text.normalize('NFKC')
    .replace(/[ؐ-ًؚ-ٰٟۖ-ۜ۟-۪ۨ-ۭـ​-‏‪-‮⁠-⁩﻿­]/g, '')
    .replace(/[آأإٱ]/g, 'ا').replace(/[ىی]/g, 'ي').replace(/ة/g, 'ه').replace(/ک/g, 'ك')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6F0));
}

const WIN1252: Record<number, number> = {
  0x80: 0x20AC, 0x82: 0x201A, 0x83: 0x0192, 0x84: 0x201E, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
  0x88: 0x02C6, 0x89: 0x2030, 0x8A: 0x0160, 0x8B: 0x2039, 0x8C: 0x0152, 0x8E: 0x017D,
  0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201C, 0x94: 0x201D, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02DC, 0x99: 0x2122, 0x9A: 0x0161, 0x9B: 0x203A, 0x9C: 0x0153, 0x9E: 0x017E, 0x9F: 0x0178,
};

const decode = (text: string): string => text.replace(/&(?:#(\d+);?|#[xX]([0-9a-fA-F]+);?|([a-zA-Z][a-zA-Z0-9]*)(;?))/g, (whole, decimal: string | undefined, hex: string | undefined, name: string | undefined, semi: string | undefined) => {
  if (name !== undefined) {
    if (semi && Object.hasOwn(ENTITIES, name)) return ENTITIES[name]!;
    for (let len = Math.min(name.length, 6); len >= 2; len--) {
      const prefix = name.slice(0, len);
      if (LEGACY_ENTITIES.has(prefix)) return ENTITIES[prefix]! + name.slice(len) + (semi ?? '');
    }
    return whole;
  }
  const raw = (decimal ?? hex!).replace(/^0+/, '') || '0';
  const point = raw.length > 7 ? 0x110000 : Number.parseInt(raw, decimal !== undefined ? 10 : 16);
  if (Object.hasOwn(WIN1252, point)) return String.fromCodePoint(WIN1252[point]!);
  return point > 0 && point <= 0x10FFFF && (point < 0xD800 || point > 0xDFFF) ? String.fromCodePoint(point) : ' ';
});

const HIDDEN = new Set(['script', 'style', 'template', 'noscript', 'iframe', 'object']);
const BLOCKS = new Set('address article aside blockquote button caption dd details dialog div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup label legend li main menu nav ol option p pre search section summary table tbody td tfoot th thead title tr ul text br hr img input'.split(' '));
const VOID = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
const P_CLOSERS = new Set('address article aside blockquote details div dl fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr main menu nav ol p pre search section table ul'.split(' '));
const IMPLICIT_CLOSE = new Map<string, Set<string>>([
  ['p', P_CLOSERS],
  ['li', new Set(['li'])],
  ['dt', new Set(['dt', 'dd'])],
  ['dd', new Set(['dt', 'dd'])],
  ['option', new Set(['option', 'optgroup'])],
  ['optgroup', new Set(['optgroup'])],
  ['rt', new Set(['rt', 'rp'])],
  ['rp', new Set(['rt', 'rp'])],
  ['thead', new Set(['tbody', 'tfoot'])],
  ['tbody', new Set(['tbody', 'tfoot'])],
  ['tfoot', new Set(['tbody', 'tfoot'])],
  ['tr', new Set(['tr', 'thead', 'tbody', 'tfoot'])],
  ['td', new Set(['td', 'th', 'tr', 'thead', 'tbody', 'tfoot'])],
  ['th', new Set(['td', 'th', 'tr', 'thead', 'tbody', 'tfoot'])],
  ['caption', new Set(['colgroup', 'thead', 'tbody', 'tfoot', 'tr'])],
  ['head', new Set(['body'])],
]);
const GENERAL_SCOPE = ['applet', 'caption', 'html', 'marquee', 'math', 'object', 'svg', 'table', 'td', 'th', 'template'];
const TABLE_SCOPE = new Set(['table', 'template', 'html']);
const SCOPE_STOP = new Map<string, Set<string>>([
  ['p', new Set([...GENERAL_SCOPE, 'button'])],
  ['li', new Set([...GENERAL_SCOPE, 'ol', 'ul', 'menu'])],
  ['dt', new Set([...GENERAL_SCOPE, 'dl'])],
  ['dd', new Set([...GENERAL_SCOPE, 'dl'])],
  ['option', new Set([...GENERAL_SCOPE, 'select', 'datalist'])],
  ['optgroup', new Set([...GENERAL_SCOPE, 'select', 'datalist'])],
  ['rt', new Set([...GENERAL_SCOPE, 'ruby'])],
  ['rp', new Set([...GENERAL_SCOPE, 'ruby'])],
  ['thead', TABLE_SCOPE],
  ['tbody', TABLE_SCOPE],
  ['tfoot', TABLE_SCOPE],
  ['tr', TABLE_SCOPE],
  ['td', TABLE_SCOPE],
  ['th', TABLE_SCOPE],
  ['caption', TABLE_SCOPE],
  ['head', new Set(['html'])],
]);
const DISPLAY_OUTSIDE = new Set(['block', 'inline', 'run-in']);
const DISPLAY_INSIDE = new Set(['flow', 'flow-root', 'table', 'flex', 'grid', 'ruby']);
const DISPLAY_SINGLE = new Set([
  'initial', 'inherit', 'unset', 'revert', 'revert-layer', 'none', 'contents',
  ...DISPLAY_OUTSIDE, ...DISPLAY_INSIDE,
  'inline-block', 'inline-table', 'inline-flex', 'inline-grid', 'inline-ruby', 'list-item',
  'table-row-group', 'table-header-group', 'table-footer-group', 'table-row', 'table-cell', 'table-column-group', 'table-column', 'table-caption',
  'ruby-base', 'ruby-text', 'ruby-base-container', 'ruby-text-container',
  '-webkit-box', '-webkit-inline-box', '-webkit-flex', '-webkit-inline-flex',
]);

function isValidDisplay(value: string): boolean {
  const tokens = value.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 1) return DISPLAY_SINGLE.has(tokens[0]!);
  if (tokens.length < 2 || tokens.length > 3) return false;
  let outside = false, inside: string | null = null, listItem = false;
  for (const token of tokens) {
    if (DISPLAY_OUTSIDE.has(token)) { if (outside) return false; outside = true; }
    else if (DISPLAY_INSIDE.has(token)) { if (inside !== null) return false; inside = token; }
    else if (token === 'list-item') { if (listItem) return false; listItem = true; }
    else return false;
  }
  return !listItem || inside === null || inside === 'flow' || inside === 'flow-root';
}

function isDisplayNone(style: string | null): boolean {
  if (!style) return false;
  let hidden = false, important = false, buf = '', quote = '', parens = 0;
  const check = (decl: string) => {
    const colon = decl.indexOf(':');
    if (colon < 0) return;
    if (decl.slice(0, colon).trim().toLowerCase() !== 'display') return;
    let value = decl.slice(colon + 1).trim();
    const imp = /\s*!\s*important$/i.test(value);
    if (imp) value = value.replace(/\s*!\s*important$/i, '').trim();
    if (!isValidDisplay(value)) return;
    if (imp || !important) {
      hidden = value.toLowerCase() === 'none';
      if (imp) important = true;
    }
  };
  for (let i = 0; i < style.length; i++) {
    const ch = style[i]!;
    if (quote) {
      buf += ch;
      if (ch === '\\' && i + 1 < style.length) { buf += style[++i]!; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && style[i + 1] === '*') {
      const end = style.indexOf('*/', i + 2);
      buf += ' ';
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === '(') { parens++; buf += ch; continue; }
    if (ch === ')') { if (parens > 0) parens--; buf += ch; continue; }
    if (ch === ';' && parens === 0) { check(buf); buf = ''; continue; }
    buf += ch;
  }
  if (!quote && buf) check(buf);
  return hidden;
}

function cutBytes(text: string, max: number): string {
  const encoded = encoder.encode(text);
  if (encoded.byteLength <= max) return text;
  let n = max;
  // Back up past UTF-8 continuation bytes so we never split a multi-byte character.
  while (n > 0 && (encoded[n]! & 0xC0) === 0x80) n--;
  return decoder.decode(encoded.subarray(0, n)).trimEnd();
}

/** What a person would read in an HTML file, up to 200 KB of UTF-8 text, from its first 3 MB. */
export async function visibleText(html: ReadableStream<Uint8Array>): Promise<string> {
  let seen = 0, bytes = 0, seq = 0, hiddenCount = 0, hadSpace = true, pending = '';
  const parts: string[] = [];
  const open: { id: number; tag: string; hidden: boolean }[] = [];
  const add = (text: string) => {
    if (bytes >= MAX_BYTES) return;
    const collapsed = text.replace(/\s+/g, ' ');
    const out = hadSpace && collapsed.startsWith(' ') ? collapsed.slice(1) : collapsed;
    if (!out) return;
    hadSpace = out.endsWith(' ');
    parts.push(out);
    bytes += encoder.encode(out).byteLength;
  };
  const popTo = (index: number) => {
    while (open.length > index) if (open.pop()!.hidden) hiddenCount--;
  };
  const closeTo = (id: number) => {
    while (open.length > 0 && open[open.length - 1]!.id >= id) if (open.pop()!.hidden) hiddenCount--;
  };
  const popImplicit = (tag: string) => {
    const between = new Set<string>();
    for (let i = open.length - 1; i >= 0; i--) {
      const entry = open[i]!;
      const closers = IMPLICIT_CLOSE.get(entry.tag);
      if (closers?.has(tag)) {
        const stop = SCOPE_STOP.get(entry.tag)!;
        let blocked = false;
        for (const ancestor of between) if (stop.has(ancestor)) { blocked = true; break; }
        if (!blocked) {
          popTo(i);
          between.clear();
          continue;
        }
      }
      between.add(entry.tag);
      if (TABLE_SCOPE.has(entry.tag)) break;
    }
  };
  const limited = html.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const room = MAX_HTML - seen;
      seen += chunk.byteLength;
      controller.enqueue(chunk.byteLength > room ? chunk.subarray(0, room) : chunk);
      if (seen >= MAX_HTML || bytes >= MAX_BYTES) controller.terminate();
    },
  }));
  const rewriter = new HTMLRewriter(), end = (el: Element, then: () => void): boolean => { try { el.onEndTag(then); return true; } catch { return false; /* closes itself */ } };
  rewriter.on('*', {
    element(el) {
      const tag = el.tagName.toLowerCase();
      popImplicit(tag);
      const hide = HIDDEN.has(tag)
        || (el.hasAttribute('hidden') && el.getAttribute('hidden')?.toLowerCase() !== 'until-found')
        || isDisplayNone(el.getAttribute('style'));
      const block = BLOCKS.has(tag);
      if (block && hiddenCount === 0) add(' ');
      if (VOID.has(tag)) return;
      const id = ++seq;
      const ok = end(el, () => { closeTo(id); if (block && hiddenCount === 0) add(' '); });
      if (ok) {
        open.push({ id, tag, hidden: hide });
        if (hide) hiddenCount++;
      }
    },
  });
  rewriter.onDocument({
    text(chunk) {
      if (hiddenCount > 0) { pending = ''; return; }
      // An entity can be cut between two chunks, or across a 64 KB buffer flush.
      pending += chunk.text;
      if (!chunk.lastInTextNode && pending.length < 65_536) return;
      let flush = pending;
      pending = '';
      if (!chunk.lastInTextNode) {
        const cut = flush.lastIndexOf('&');
        if (cut >= 0 && flush.length - cut <= 64 && !/[;\s]/.test(flush.slice(cut))) {
          pending = flush.slice(cut);
          flush = flush.slice(0, cut);
        }
      }
      if (flush) add(decode(flush));
    },
  });
  await rewriter.transform(new Response(limited, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })).body!.pipeTo(new WritableStream());
  if (pending && hiddenCount === 0) add(decode(pending));
  return cutBytes(parts.join('').trim().toWellFormed(), MAX_BYTES);
}

/** A filter's token in the index: the kind, then the value in hex, so the tokenizer never splits it. */
export const token = (kind: 'p' | 's' | 't', value: string): string => kind + Array.from(encoder.encode(value), (b) => b.toString(16).padStart(2, '0')).join('');

/** The words of a search, each a prefix; null when there is nothing to search for. `"` is the only character that means something inside a quoted word. */
export function words(q: string): string | null {
  const found = normalize(q).replaceAll('\u0000', ' ').split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word));
  return found.length === 0 ? null : found.map((word) => `"${word.replaceAll('"', '""')}"*`).join(' AND ');
}
