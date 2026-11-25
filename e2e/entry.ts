// Test only. One local server for both Workers, told apart by host name as in a real copy, and a door to the database.
interface Env { APP: Fetcher; CONTENT: Fetcher; DB: D1Database }

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.headers.get('X-Lawh-E2E') === 'database') return Response.json((await env.DB.batch((await request.json<string[]>()).map((s) => env.DB.prepare(s)))).map((r) => r.results));
    return (url.hostname === '127.0.0.1' ? env.CONTENT : env.APP).fetch(request);
  },
} satisfies ExportedHandler<Env>;
