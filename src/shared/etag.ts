/** If-None-Match compares weakly: the edge makes an ETag weak when it compresses. */
export function matchesEtag(header: string | null, etag: string): boolean {
  return (header ?? '').split(',').map((tag) => tag.trim().replace(/^W\//, '')).some((tag) => tag === etag || tag === '*');
}
