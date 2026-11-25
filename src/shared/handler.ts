import type { SharedEnv } from './env';
import { errorResponse } from './errors';
import { isOn } from './switches';

type Route<E> = (request: Request, env: E, ctx: ExecutionContext) => Promise<Response> | Response;

/** For a failure in building the host's own headers. */
const FALLBACK_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

/** Adds the host's headers. A route may set its own CSP or caching; nothing else of it is kept. */
function withHeaders(response: Response, headers: Record<string, string>): Response {
  const result = new Response(response.body, response);
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'content-security-policy' || !result.headers.get(name)) result.headers.set(name, value);
  }
  if (!result.headers.get('Cache-Control')) result.headers.set('Cache-Control', 'no-store');
  return result;
}

/**
 * Wraps a Worker's routes: nothing but `openWhenOff` is reachable while `instance` is off, a failure never shows details, and
 * every response gets the host's headers.
 */
export function guarded<E extends SharedEnv>(route: Route<E>, headers: (env: E) => Record<string, string>, openWhenOff: (request: Request) => boolean = () => false): Route<E> {
  return async (request, env, ctx) => {
    try {
      const response = openWhenOff(request) || (await isOn(env.DB, 'instance'))
        ? await route(request, env, ctx)
        : errorResponse('feature_off', 'This feature is off.');
      return withHeaders(response, headers(env));
    } catch (error) {
      // The name only: a message can hold page text, and logs must not.
      console.error('unhandled', error instanceof Error ? error.name : typeof error);
      const failure = () => errorResponse('internal', 'Something went wrong.');
      try {
        return withHeaders(failure(), headers(env));
      } catch {
        return withHeaders(failure(), FALLBACK_HEADERS);
      }
    }
  };
}
