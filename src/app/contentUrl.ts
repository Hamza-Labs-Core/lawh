import { makeContentToken } from '../shared/contentToken';
import { readSecret } from '../shared/crypto';
import type { AppEnv } from '../shared/env';
import { checkedOrigin } from '../shared/origin';

/** The address of one version's page, for the sandboxed frame. The caller checks access first. */
export async function contentUrl(env: AppEnv, versionId: string, entry: string, mode: 'dark' | 'light', lang: 'en' | 'ar'): Promise<string> {
  const token = await makeContentToken(await readSecret(env.CONTENT_KEY), versionId);
  return `${checkedOrigin(env.CONTENT_ORIGIN)}/${token}/${entry.split('/').map(encodeURIComponent).join('/')}?mode=${mode}&lang=${lang}`;
}
