// Local only. One server for both Workers, told apart by host name as in a real copy; in browser tests, also a door to
// the database.
interface Env { APP: Fetcher; CONTENT: Fetcher; DB: D1Database; TESTING: boolean }

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (env.TESTING && request.headers.get('X-Lawh-E2E') === 'database') return Response.json((await env.DB.batch((await request.json<string[]>()).map((s) => env.DB.prepare(s)))).map((r) => r.results));
    return (url.hostname === '127.0.0.1' ? env.CONTENT : env.APP).fetch(request);
  },
} satisfies ExportedHandler<Env>;
