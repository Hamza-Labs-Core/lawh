/** Copies strings as they are, and gives every other position to `at`, which returns how far it read. */
function scan(text, at) {
  let out = '';
  for (let i = 0; i < text.length;) {
    if (text[i] === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      out += text.slice(start, ++i);
    } else {
      const [keep, next] = at(i);
      out += keep;
      i = next;
    }
  }
  return out;
}

/** Reads JSON with comments and trailing commas, as Wrangler's configs may have. */
export function parseJsonc(text) {
  const plain = scan(text, (i) => {
    if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i);
      return ['', end === -1 ? text.length : end];
    }
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) throw new Error('A comment is not closed');
      return [' ', end + 2];
    }
    return [text[i], i + 1];
  });
  return JSON.parse(scan(plain, (i) => {
    if (plain[i] !== ',') return [plain[i], i + 1];
    let next = i + 1;
    while (next < plain.length && ' \t\r\n'.includes(plain[next])) next++;
    return [plain[next] === '}' || plain[next] === ']' ? '' : ',', i + 1];
  }));
}
