/** Checks a configured origin: exact, https (or local http), nothing after the host. It goes into CSP headers. */
function checked(value: string): string {
  const url = new URL(value);
  const local = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (url.origin !== value || (url.protocol !== 'https:' && !local)) throw new Error('An origin is not valid');
  return value;
}

/** The two hosts. They must differ: everything that keeps pages from the app rests on that. */
export function origins(env: { APP_ORIGIN: string; CONTENT_ORIGIN: string }): { app: string; content: string } {
  const app = checked(env.APP_ORIGIN), content = checked(env.CONTENT_ORIGIN);
  if (new URL(app).hostname === new URL(content).hostname) throw new Error('The app and content hosts must differ');
  return { app, content };
}
