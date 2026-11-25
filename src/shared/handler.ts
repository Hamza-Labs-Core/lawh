import type { SharedEnv } from './env';
import { errorResponse } from './errors';
import { isOn } from './switches';

type Route<E> = (request: Request, env: E, ctx: ExecutionContext) => Promise<Response> | Response;

/** Adds the host's headers. A route may set its own CSP or caching; nothing else of it is kept. */
function withHeaders(response: Response, headers: Record<string, string>): Response {
  const result = new Response(response.body, response);
  for (const [name, value] of Object.entries(headers)) {
    if (name !== 'Content-Security-Policy' || !result.headers.has(name)) result.headers.set(name, value);
  }
  if (!result.headers.has('Cache-Control')) result.headers.set('Cache-Control', 'no-store');
  return result;
}

/**
 * Wraps a Worker's routes: nothing is reachable while `instance` is off, a failure never shows details, and
 * every response gets the host's headers.
 */
export function guarded<E extends SharedEnv>(route: Route<E>, headers: (env: E) => Record<string, string>): Route<E> {
  return async (request, env, ctx) => {
    try {
      const response = (await isOn(env.DB, 'instance'))
        ? await route(request, env, ctx)
        : errorResponse('feature_off', 'This feature is off.');
      return withHeaders(response, headers(env));
    } catch (error) {
      // The name only: a message can hold page text, and logs must not.
      console.error('unhandled', error instanceof Error ? error.name : typeof error);
      return withHeaders(errorResponse('internal', 'Something went wrong.'), headers(env));
    }
  };
}
