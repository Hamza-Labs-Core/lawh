import type { AppEnv } from '../../shared/env';
import { visibleText } from './text';

/** The text of a page's first file, for the search index. Other HTML files of the page aren't searched. */
export async function entryText(env: AppEnv, sha256: string): Promise<string> {
  const blob = await env.DB.prepare('SELECT r2_key FROM blobs WHERE sha256 = ?').bind(sha256).first<{ r2_key: string }>();
  const object = blob && await env.FILES.get(blob.r2_key);
  return object ? visibleText(object.body) : '';
}

export async function entryTextOf(env: AppEnv, pageId: string, n: number): Promise<string> {
  const file = await env.DB.prepare('SELECT f.sha256 FROM page_versions v JOIN version_files f ON f.version_id = v.id AND f.path = v.entry_path WHERE v.page_id = ? AND v.n = ?').bind(pageId, n).first<{ sha256: string }>();
  return file ? entryText(env, file.sha256) : '';
}
