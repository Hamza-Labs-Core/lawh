import type { AppEnv } from '../shared/env';
import { errorResponse } from '../shared/errors';
import { guarded } from '../shared/handler';
import { cleanUp } from './api/publish';
import { api } from './api/router';
import { appHeaders } from './headers';

export { LiveProject } from './live';

export default {
  fetch: guarded<AppEnv>((request, env, ctx) => {
    if (new URL(request.url).pathname.startsWith('/v1/')) return api(request, env, ctx);
    return errorResponse('not_found', 'Not found.');
  }, appHeaders),
  async scheduled(_event, env) {
    await cleanUp(env);
  },
} satisfies ExportedHandler<AppEnv>;
