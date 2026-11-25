import type { AppEnv } from '../shared/env';
import { errorResponse } from '../shared/errors';
import { guarded } from '../shared/handler';
import { appHeaders } from './headers';

export { LiveProject } from './live';

export default {
  fetch: guarded<AppEnv>(() => errorResponse('not_found', 'Not found.'), appHeaders),
} satisfies ExportedHandler<AppEnv>;
