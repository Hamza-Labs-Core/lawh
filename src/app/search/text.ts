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

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™', times: '×', divide: '÷', plusmn: '±', deg: '°', middot: '·', bull: '•', sect: '§', para: '¶',
  euro: '€', pound: '£', yen: '¥', cent: '¢', frac12: '½', frac14: '¼', frac34: '¾', shy: '', zwnj: '', zwj: '', lrm: '', rlm: '',
  Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä', Aring: 'Å', AElig: 'Æ', Ccedil: 'Ç', Egrave: 'È', Eacute: 'É', Ecirc: 'Ê', Euml: 'Ë',
  Igrave: 'Ì', Iacute: 'Í', Icirc: 'Î', Iuml: 'Ï', Ntilde: 'Ñ', Ograve: 'Ò', Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö', Oslash: 'Ø',
  Ugrave: 'Ù', Uacute: 'Ú', Ucirc: 'Û', Uuml: 'Ü', Yacute: 'Ý', szlig: 'ß',
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å', aelig: 'æ', ccedil: 'ç', egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë',
  igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï', ntilde: 'ñ', ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö', oslash: 'ø',
  ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü', yacute: 'ý', yuml: 'ÿ',
};
const decode = (text: string): string => text.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]{2,8}));?/g, (whole, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
  if (name !== undefined) return ENTITIES[name] ?? whole;
  const point = decimal !== undefined ? Number(decimal) : Number.parseInt(hex!, 16);
  return point > 0 && point <= 0x10FFFF && (point < 0xD800 || point > 0xDFFF) ? String.fromCodePoint(point) : ' ';
});

const HIDDEN = new Set(['script', 'style', 'template', 'noscript', 'iframe', 'object']);
const BLOCKS = new Set('address article aside blockquote button caption dd details dialog div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header label legend li main nav ol option p pre section summary table tbody td tfoot th thead title tr ul text br hr img input'.split(' '));
const DISPLAY_NONE = /(?:^|;)\s*display\s*:\s*none\b/i;

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
  let seen = 0, bytes = 0, hidden = 0, pending = '';
  const parts: string[] = [];
  const add = (text: string) => { if (bytes < MAX_BYTES) { parts.push(text); bytes += encoder.encode(text).byteLength; } };
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
      const hide = HIDDEN.has(tag)
        || (el.hasAttribute('hidden') && el.getAttribute('hidden')?.toLowerCase() !== 'until-found')
        || DISPLAY_NONE.test(el.getAttribute('style') ?? '');
      const block = BLOCKS.has(tag);
      if (!hide && !block) return;
      if (block && hidden === 0) add(' ');
      const ok = end(el, () => { if (hide) hidden--; if (block && hidden === 0) add(' '); });
      if (hide && ok) hidden++;
    },
  });
  rewriter.onDocument({
    text(chunk) {
      // An entity can be cut between two chunks, or across a 64 KB buffer flush.
      pending += chunk.text;
      if (!chunk.lastInTextNode && pending.length < 65_536) return;
      let flush = pending;
      pending = '';
      if (!chunk.lastInTextNode) {
        const cut = flush.lastIndexOf('&');
        if (cut >= 0 && flush.length - cut <= 12 && !flush.slice(cut).includes(';')) {
          pending = flush.slice(cut);
          flush = flush.slice(0, cut);
        }
      }
      if (hidden === 0 && flush) add(decode(flush));
    },
  });
  await rewriter.transform(new Response(limited, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })).body!.pipeTo(new WritableStream());
  if (pending && hidden === 0) add(decode(pending));
  return cutBytes(parts.join('').replace(/\s+/g, ' ').trim().toWellFormed(), MAX_BYTES);
}

/** A filter's token in the index: the kind, then the value in hex, so the tokenizer never splits it. */
export const token = (kind: 'p' | 's' | 't', value: string): string => kind + Array.from(encoder.encode(value), (b) => b.toString(16).padStart(2, '0')).join('');

/** The words of a search, each a prefix; null when there is nothing to search for. `"` is the only character that means something inside a quoted word. */
export function words(q: string): string | null {
  const found = normalize(q).replaceAll('\u0000', ' ').split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word));
  return found.length === 0 ? null : found.map((word) => `"${word.replaceAll('"', '""')}"*`).join(' AND ');
}
