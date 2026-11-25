import type { SharedEnv } from './env';
import { errorResponse } from './errors';
import { isOn } from './switches';

type Route<E> = (request: Request, env: E, ctx: ExecutionContext) => Promise<Response> | Response;

/**
 * Wraps a Worker's routes: nothing is reachable while `instance` is off, a failure never shows details, and
 * every response gets the host's headers.
 */
export function guarded<E extends SharedEnv>(route: Route<E>, headers: Record<string, string>): Route<E> {
  return async (request, env, ctx) => {
    let response: Response;
    try {
      response = (await isOn(env.DB, 'instance'))
        ? await route(request, env, ctx)
        : errorResponse('feature_off', 'This feature is off.');
    } catch (error) {
      // The name only: a message can hold page text, and logs must not.
      console.error('unhandled', error instanceof Error ? error.name : typeof error);
      response = errorResponse('internal', 'Something went wrong.');
    }
    response = new Response(response.body, response);
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
    return response;
  };
}
