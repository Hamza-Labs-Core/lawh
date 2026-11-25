/** Reads JSON with comments and trailing commas, as Wrangler's configs may have. */
export function parseJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      out += text.slice(start, i + 1);
    } else if (text.startsWith('//', i)) {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (text.startsWith('/*', i)) {
      i = text.indexOf('*/', i + 2) + 1;
      if (i === 0) throw new Error('A comment is not closed');
    } else if (text[i] === ',' && /^(?:\s|\/\/[^\n]*|\/\*[^]*?\*\/)*[}\]]/.test(text.slice(i + 1))) {
      // A trailing comma.
    } else {
      out += text[i];
    }
  }
  return JSON.parse(out);
}
