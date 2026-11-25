/** Text as it is indexed and as it is searched: the same on both sides. */

const MAX_TEXT = 200_000, MAX_HTML = 3_000_000;

/** No diacritics, one form of each Arabic letter that people write in several ways, Western digits. The index itself folds case and Latin accents. */
export function normalize(text: string): string {
  return text.normalize('NFKC')
    .replace(/[ؐ-ًؚ-ٰٟۖ-ۜ۟-۪ۨ-ۭـ​-‏‪-‮⁠-⁩﻿­]/g, '')
    .replace(/[آأإٱ]/g, 'ا').replace(/[ىی]/g, 'ي').replace(/ة/g, 'ه').replace(/ک/g, 'ك')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6F0));
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', times: '×', euro: '€', shy: '', zwnj: '', zwj: '' };
const decode = (text: string): string => text.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]{2,8}));?/g, (whole, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
  if (name !== undefined) return ENTITIES[name] ?? whole;
  const point = decimal !== undefined ? Number(decimal) : Number.parseInt(hex!, 16);
  return point > 0 && point <= 0x10FFFF && (point < 0xD800 || point > 0xDFFF) ? String.fromCodePoint(point) : ' ';
});

const HIDDEN = ['script', 'style', 'template', 'noscript', 'iframe', 'object'];
const BLOCKS = 'address article aside blockquote button caption dd details dialog div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header label legend li main nav ol option p pre section summary table tbody td tfoot th thead title tr ul text br hr img input'.split(' ');

/** What a person would read in an HTML file, up to 200,000 characters, from its first 3 MB. */
export async function visibleText(html: ReadableStream<Uint8Array>): Promise<string> {
  let seen = 0, length = 0, hidden = 0, pending = '';
  const parts: string[] = [];
  const add = (text: string) => { if (length < MAX_TEXT) { parts.push(text); length += text.length; } };
  const limited = html.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const room = MAX_HTML - seen;
      seen += chunk.byteLength;
      controller.enqueue(chunk.byteLength > room ? chunk.subarray(0, room) : chunk);
      if (seen >= MAX_HTML || length >= MAX_TEXT) controller.terminate();
    },
  }));
  const rewriter = new HTMLRewriter(), end = (el: Element, then: () => void): boolean => { try { el.onEndTag(then); return true; } catch { return false; /* closes itself */ } };
  for (const name of HIDDEN) rewriter.on(name, { element(el) { if (end(el, () => { hidden--; })) hidden++; } });
  for (const name of BLOCKS) rewriter.on(name, { element(el) { add(' '); end(el, () => add(' ')); } });
  rewriter.onDocument({
    text(chunk) {
      // An entity can be cut between two chunks.
      pending += chunk.text;
      if (!chunk.lastInTextNode && pending.length < 65_536) return;
      if (hidden === 0) add(decode(pending));
      pending = '';
    },
  });
  await rewriter.transform(new Response(limited, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })).body!.pipeTo(new WritableStream());
  return parts.join('').replace(/\s+/g, ' ').trimStart().slice(0, MAX_TEXT).toWellFormed().trimEnd();
}

/** A filter's token in the index: the kind, then the value in hex, so the tokenizer never splits it. */
export const token = (kind: 'p' | 's' | 't', value: string): string => kind + Array.from(new TextEncoder().encode(value), (b) => b.toString(16).padStart(2, '0')).join('');

/** The words of a search, each a prefix; null when there is nothing to search for. `"` is the only character that means something inside a quoted word. */
export function words(q: string): string | null {
  const found = normalize(q).replaceAll('\u0000', ' ').split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).slice(0, 10);
  return found.length === 0 ? null : found.map((word) => `"${word.replaceAll('"', '""')}"*`).join(' AND ');
}
