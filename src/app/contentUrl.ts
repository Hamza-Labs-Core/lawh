import { makeContentToken } from '../shared/contentToken';
import { readSecret } from '../shared/crypto';
import type { AppEnv } from '../shared/env';
import { origins } from '../shared/origin';

/** The address of the full-size viewer for one version's pictures. */
export async function viewerUrl(env: AppEnv, versionId: string): Promise<string> {
  return `${origins(env).content}/${await makeContentToken(await readSecret(env.CONTENT_KEY), versionId)}/_lawh/viewer`;
}

/** The address of one version's page, for the sandboxed frame. The caller checks access first. */
export async function contentUrl(env: AppEnv, versionId: string, entry: string, mode: 'dark' | 'light', lang: 'en' | 'ar'): Promise<string> {
  const token = await makeContentToken(await readSecret(env.CONTENT_KEY), versionId);
  return `${origins(env).content}/${token}/${entry.split('/').map(encodeURIComponent).join('/')}?mode=${mode}&lang=${lang}`;
}
