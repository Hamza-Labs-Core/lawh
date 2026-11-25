import type { ContentEnv } from '../shared/env';
import { errorResponse } from '../shared/errors';
import { guarded } from '../shared/handler';

/** The page headers of security model section 2 come with S3, together with the files they protect. */
const contentHeaders: Record<string, string> = {
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export default {
  fetch: guarded<ContentEnv>(() => errorResponse('not_found', 'Not found.'), contentHeaders),
} satisfies ExportedHandler<ContentEnv>;
