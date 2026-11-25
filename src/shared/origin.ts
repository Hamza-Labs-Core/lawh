/** Checks a configured origin: exact, https (or local http), nothing after the host. It goes into CSP headers. */
export function checkedOrigin(value: string): string {
  const url = new URL(value);
  const local = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (url.origin !== value || (url.protocol !== 'https:' && !local)) throw new Error('An origin is not valid');
  return value;
}
