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
// WHATWG §13.2.4.2 special elements excluding address, div, and p (the barrier for li/dt/dd implicit closing).
const SPECIAL_STOP = new Set(
  'applet area article aside base basefont bgsound blockquote body br button caption center col colgroup dd details dir dl dt embed fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hgroup hr html iframe img input keygen li link listing main marquee math menu meta nav noembed noframes noscript object ol param plaintext pre script search section select source style summary svg table tbody td template textarea tfoot th thead title tr track ul wbr xmp'.split(' '),
);
const SELECT_SCOPE = new Set([...GENERAL_SCOPE, 'select', 'datalist']);
const RUBY_SCOPE = new Set([...GENERAL_SCOPE, 'ruby']);
const HEAD_SCOPE = new Set(['html']);
const P_SCOPE = new Set([...GENERAL_SCOPE, 'button']);
// Bit index per closable group so element() skips implicit-close scans in O(1) whenever nothing closable is open.
const CLOSABLE_BIT = new Map<string, number>([
  ['p', 0], ['li', 1], ['dt', 2], ['dd', 2], ['option', 3], ['optgroup', 4],
  ['rt', 5], ['rp', 5], ['thead', 6], ['tbody', 6], ['tfoot', 6], ['tr', 7],
  ['td', 8], ['th', 8], ['caption', 9], ['head', 10],
]);
const GROUP_STOP: Set<string>[] = [
  P_SCOPE, SPECIAL_STOP, SPECIAL_STOP, SELECT_SCOPE, SELECT_SCOPE,
  RUBY_SCOPE, TABLE_SCOPE, TABLE_SCOPE, TABLE_SCOPE, TABLE_SCOPE, HEAD_SCOPE,
];
const CLOSER_MASK = new Map<string, number>();
for (const [target, closers] of IMPLICIT_CLOSE) {
  const bit = 1 << CLOSABLE_BIT.get(target)!;
  for (const closer of closers) CLOSER_MASK.set(closer, (CLOSER_MASK.get(closer) ?? 0) | bit);
}

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

const BANG = Symbol('!');
const isCssSpace = (ch: string) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\f' || ch === '\r';
const isHex = (ch: string) => (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');

/** Tokenize a CSS property or value per CSS Syntax Level 3 (ASCII whitespace only, CSS escapes, unescaped `!` delimiter). */
function cssTokens(raw: string): (string | typeof BANG)[] | null {
  const out: (string | typeof BANG)[] = [];
  let cur = '';
  const flush = () => { if (cur) { out.push(cur.toLowerCase()); cur = ''; } };
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (isCssSpace(ch)) { flush(); continue; }
    if (ch === '!') { flush(); out.push(BANG); continue; }
    if (ch === '\\') {
      if (i + 1 >= raw.length) { cur += '\uFFFD'; continue; }
      const next = raw[i + 1]!;
      if (next === '\n' || next === '\f' || next === '\r') return null;
      if (isHex(next)) {
        let j = i + 1;
        while (j < raw.length && j - (i + 1) < 6 && isHex(raw[j]!)) j++;
        const code = Number.parseInt(raw.slice(i + 1, j), 16);
        cur += code === 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF) ? '\uFFFD' : String.fromCodePoint(code);
        if (j < raw.length && raw[j] === '\r' && raw[j + 1] === '\n') j += 2;
        else if (j < raw.length && isCssSpace(raw[j]!)) j++;
        i = j - 1;
      } else {
        cur += next;
        i++;
      }
      continue;
    }
    cur += ch;
  }
  flush();
  return out;
}

function isValidDisplay(tokens: (string | typeof BANG)[]): boolean {
  if (tokens.length === 1) return typeof tokens[0] === 'string' && DISPLAY_SINGLE.has(tokens[0]);
  if (tokens.length < 2 || tokens.length > 3) return false;
  let outside = false, inside: string | null = null, listItem = false;
  for (const token of tokens) {
    if (typeof token !== 'string') return false;
    if (DISPLAY_OUTSIDE.has(token)) { if (outside) return false; outside = true; }
    else if (DISPLAY_INSIDE.has(token)) { if (inside !== null) return false; inside = token; }
    else if (token === 'list-item') { if (listItem) return false; listItem = true; }
    else return false;
  }
  return !listItem || inside === null || inside === 'flow' || inside === 'flow-root';
}

const MATCH_CLOSE: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

function isDisplayNone(style: string | null): boolean {
  if (!style) return false;
  let hidden = false, important = false, buf = '', quote = '';
  const blocks: string[] = [];
  const check = (decl: string) => {
    const colon = decl.indexOf(':');
    if (colon < 0) return;
    const prop = cssTokens(decl.slice(0, colon));
    if (!prop || prop.length !== 1 || prop[0] !== 'display') return;
    const tokens = cssTokens(decl.slice(colon + 1));
    if (!tokens || tokens.length === 0) return;
    let imp = false;
    if (tokens.length >= 2 && tokens[tokens.length - 2] === BANG && tokens[tokens.length - 1] === 'important') {
      imp = true;
      tokens.length -= 2;
    }
    if (!isValidDisplay(tokens)) return;
    if (imp || !important) {
      hidden = tokens.length === 1 && tokens[0] === 'none';
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
    if (ch === '\\' && i + 1 < style.length) { buf += ch + style[++i]!; continue; }
    if (ch === '/' && style[i + 1] === '*') {
      const end = style.indexOf('*/', i + 2);
      buf += ' ';
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (Object.hasOwn(MATCH_CLOSE, ch)) { blocks.push(MATCH_CLOSE[ch]!); buf += ch; continue; }
    if (blocks.length > 0 && ch === blocks[blocks.length - 1]) { blocks.pop(); buf += ch; continue; }
    if (ch === ';' && blocks.length === 0) { check(buf); buf = ''; continue; }
    buf += ch;
  }
  if (!quote && blocks.length === 0 && buf) check(buf);
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

const INCOMPLETE_ENTITY = /^&(?:#(?:[0-9]+|[xX][0-9a-fA-F]*)?|[a-zA-Z][a-zA-Z0-9]{0,31})?$/;

/** What a person would read in an HTML file, up to 200 KB of UTF-8 text, from its first 3 MB. */
export async function visibleText(html: ReadableStream<Uint8Array>): Promise<string> {
  let seen = 0, bytes = 0, seq = 0, hiddenCount = 0, closableMask = 0, hadSpace = true, pending = '';
  const parts: string[] = [];
  const counts = new Int32Array(GROUP_STOP.length);
  const open: { id: number; tag: string; hidden: boolean; bit: number }[] = [];
  const add = (text: string) => {
    if (bytes >= MAX_BYTES) return;
    const collapsed = text.replace(/\s+/g, ' ');
    const out = hadSpace && collapsed.startsWith(' ') ? collapsed.slice(1) : collapsed;
    if (!out) return;
    hadSpace = out.endsWith(' ');
    parts.push(out);
    bytes += encoder.encode(out).byteLength;
  };
  const popOne = () => {
    const entry = open.pop()!;
    if (entry.hidden) hiddenCount--;
    if (entry.bit >= 0 && --counts[entry.bit]! === 0) closableMask &= ~(1 << entry.bit);
  };
  const closeTo = (id: number) => {
    while (open.length > 0 && open[open.length - 1]!.id >= id) popOne();
  };
  const popImplicit = (tag: string, mask: number) => {
    let remaining = closableMask & mask;
    for (let i = open.length - 1; i >= 0 && remaining !== 0; i--) {
      const entry = open[i]!;
      const bit = entry.bit;
      if (bit >= 0 && (remaining & (1 << bit)) !== 0 && IMPLICIT_CLOSE.get(entry.tag)?.has(tag)) {
        while (open.length > i) popOne();
        remaining &= closableMask;
        continue;
      }
      for (let b = 0; b < GROUP_STOP.length; b++) {
        if ((remaining & (1 << b)) !== 0 && GROUP_STOP[b]!.has(entry.tag)) remaining &= ~(1 << b);
      }
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
      const mask = CLOSER_MASK.get(tag) ?? 0;
      if ((closableMask & mask) !== 0) popImplicit(tag, mask);
      const hide = HIDDEN.has(tag)
        || (el.hasAttribute('hidden') && el.getAttribute('hidden')?.toLowerCase() !== 'until-found')
        || isDisplayNone(el.getAttribute('style'));
      const block = BLOCKS.has(tag);
      if (block && hiddenCount === 0) add(' ');
      if (VOID.has(tag)) return;
      const id = ++seq;
      const ok = end(el, () => { closeTo(id); if (block && hiddenCount === 0) add(' '); });
      if (ok) {
        const bit = CLOSABLE_BIT.get(tag) ?? -1;
        open.push({ id, tag, hidden: hide, bit });
        if (hide) hiddenCount++;
        if (bit >= 0 && counts[bit]!++ === 0) closableMask |= (1 << bit);
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
        if (cut >= 0) {
          const tail = flush.slice(cut);
          if (INCOMPLETE_ENTITY.test(tail)) {
            // Collapse arbitrarily long leading-zero runs in numeric references so pending stays tiny.
            pending = tail.replace(/^(&#[xX]?)0+/, '$10');
            flush = flush.slice(0, cut);
          }
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
