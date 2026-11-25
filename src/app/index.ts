import type { AppEnv } from '../shared/env';
import { guarded } from '../shared/handler';
import { cleanUp } from './api/publish';
import { api } from './api/router';
import { appHeaders } from './headers';
import { cleanUpPeople } from './people/cleanUp';
import { appApi, appApiOpenWhenOff } from './people/router';
import { isOpenPage, servePage } from './site';

export { LiveProject } from './live';

const isAppApi = (url: URL): boolean => url.pathname.startsWith('/app-api/');

export default {
  fetch: guarded<AppEnv>((request, env, ctx) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/v1/')) return api(request, env, ctx);
    if (isAppApi(url)) return appApi(request, env, ctx);
    return servePage(request, env, url);
  }, appHeaders, (request) => {
    const url = new URL(request.url);
    return isAppApi(url) ? appApiOpenWhenOff(request) : isOpenPage(request, url);
  }),
  async scheduled(_event, env) {
    // One failing must not keep the other from running.
    const results = await Promise.allSettled([cleanUp(env), cleanUpPeople(env)]);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw new Error('Clean-up failed');
  },
} satisfies ExportedHandler<AppEnv>;
