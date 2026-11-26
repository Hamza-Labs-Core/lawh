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

const decode = (text: string): string => text.replace(/&(?:#(\d{1,7});?|#[xX]([0-9a-fA-F]{1,6});?|([a-zA-Z][a-zA-Z0-9]{1,30})(;?))/g, (whole, decimal: string | undefined, hex: string | undefined, name: string | undefined, semi: string | undefined) => {
  if (name !== undefined) {
    if (semi) return Object.hasOwn(ENTITIES, name) ? ENTITIES[name]! : whole;
    return LEGACY_ENTITIES.has(name) ? ENTITIES[name]! : whole;
  }
  const point = decimal !== undefined ? Number(decimal) : Number.parseInt(hex!, 16);
  return point > 0 && point <= 0x10FFFF && (point < 0xD800 || point > 0xDFFF) ? String.fromCodePoint(point) : ' ';
});

const HIDDEN = new Set(['script', 'style', 'template', 'noscript', 'iframe', 'object']);
const BLOCKS = new Set('address article aside blockquote button caption dd details dialog div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup label legend li main menu nav ol option p pre search section summary table tbody td tfoot th thead title tr ul text br hr img input'.split(' '));
const VOID = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
const P_CLOSERS = new Set('address article aside blockquote details div dl fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr main menu nav ol p pre search section table ul'.split(' '));
const IMPLICIT_CLOSE: Record<string, Set<string>> = {
  p: P_CLOSERS,
  li: new Set(['li']),
  dt: new Set(['dt', 'dd']),
  dd: new Set(['dt', 'dd']),
  option: new Set(['option', 'optgroup']),
  optgroup: new Set(['optgroup']),
  rt: new Set(['rt', 'rp']),
  rp: new Set(['rt', 'rp']),
  thead: new Set(['tbody', 'tfoot']),
  tbody: new Set(['tbody', 'tfoot']),
  tfoot: new Set(['tbody', 'tfoot']),
  tr: new Set(['tr', 'thead', 'tbody', 'tfoot']),
  td: new Set(['td', 'th', 'tr', 'thead', 'tbody', 'tfoot']),
  th: new Set(['td', 'th', 'tr', 'thead', 'tbody', 'tfoot']),
  caption: new Set(['colgroup', 'thead', 'tbody', 'tfoot', 'tr']),
  head: new Set(['body']),
};
const DISPLAY_VALUE = /^[a-z-]+(?:\s+[a-z-]+){0,2}$/i;

function isDisplayNone(style: string | null): boolean {
  if (!style) return false;
  const clean = style.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, '');
  let hidden = false, important = false, start = 0, quote = '', parens = 0;
  for (let i = 0; i <= clean.length; i++) {
    const ch = clean[i] ?? ';';
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(') { parens++; continue; }
    if (ch === ')') { if (parens > 0) parens--; continue; }
    if (ch !== ';' || parens > 0) continue;
    const decl = clean.slice(start, i);
    start = i + 1;
    const colon = decl.indexOf(':');
    if (colon < 0) continue;
    if (decl.slice(0, colon).trim().toLowerCase() !== 'display') continue;
    let value = decl.slice(colon + 1).trim();
    const imp = /\s*!\s*important$/i.test(value);
    if (imp) value = value.replace(/\s*!\s*important$/i, '').trim();
    if (!DISPLAY_VALUE.test(value)) continue;
    if (imp || !important) {
      hidden = value.toLowerCase() === 'none';
      if (imp) important = true;
    }
  }
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
  let seen = 0, bytes = 0, seq = 0, hadSpace = true, pending = '';
  const parts: string[] = [];
  const hiddenStack: { id: number; tag: string }[] = [];
  const add = (text: string) => {
    if (bytes >= MAX_BYTES) return;
    const collapsed = text.replace(/\s+/g, ' ');
    const out = hadSpace && collapsed.startsWith(' ') ? collapsed.slice(1) : collapsed;
    if (!out) return;
    hadSpace = out.endsWith(' ');
    parts.push(out);
    bytes += encoder.encode(out).byteLength;
  };
  const closeTo = (id: number) => {
    while (hiddenStack.length > 0 && hiddenStack[hiddenStack.length - 1]!.id >= id) hiddenStack.pop();
  };
  const popImplicit = (tag: string) => {
    for (let i = hiddenStack.length - 1; i >= 0; i--) {
      const entry = hiddenStack[i]!;
      if (IMPLICIT_CLOSE[entry.tag]?.has(tag)) { hiddenStack.length = i; continue; }
      if (BLOCKS.has(entry.tag) || HIDDEN.has(entry.tag)) break;
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
      if (block && hiddenStack.length === 0) add(' ');
      if (VOID.has(tag)) return;
      const id = ++seq;
      const ok = end(el, () => { closeTo(id); if (block && hiddenStack.length === 0) add(' '); });
      if (hide && ok) hiddenStack.push({ id, tag });
    },
  });
  rewriter.onDocument({
    text(chunk) {
      if (hiddenStack.length > 0) { pending = ''; return; }
      // An entity can be cut between two chunks, or across a 64 KB buffer flush (longest HTML5 name is 31 chars).
      pending += chunk.text;
      if (!chunk.lastInTextNode && pending.length < 65_536) return;
      let flush = pending;
      pending = '';
      if (!chunk.lastInTextNode) {
        const cut = flush.lastIndexOf('&');
        if (cut >= 0 && flush.length - cut <= 34 && !flush.slice(cut).includes(';')) {
          pending = flush.slice(cut);
          flush = flush.slice(0, cut);
        }
      }
      if (flush) add(decode(flush));
    },
  });
  await rewriter.transform(new Response(limited, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })).body!.pipeTo(new WritableStream());
  if (pending && hiddenStack.length === 0) add(decode(pending));
  return cutBytes(parts.join('').trim().toWellFormed(), MAX_BYTES);
}

/** A filter's token in the index: the kind, then the value in hex, so the tokenizer never splits it. */
export const token = (kind: 'p' | 's' | 't', value: string): string => kind + Array.from(encoder.encode(value), (b) => b.toString(16).padStart(2, '0')).join('');

/** The words of a search, each a prefix; null when there is nothing to search for. `"` is the only character that means something inside a quoted word. */
export function words(q: string): string | null {
  const found = normalize(q).replaceAll('\u0000', ' ').split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word));
  return found.length === 0 ? null : found.map((word) => `"${word.replaceAll('"', '""')}"*`).join(' AND ');
}
