/** Per-isolate budget. Henry's templates are ~6 MB each, so a few stay hot across a bulk reissue. */
export const ASSET_CACHE_MAX_BYTES = 48 * 1024 * 1024;

const cache = new Map<string, Uint8Array>();
let total = 0;

/**
 * Entries are content-addressed (`sha1` is part of the key), so a hit is always the right bytes.
 * Entries without a digest are never cached.
 */
function keyOf(
  templateId: string,
  version: string,
  entry: { name: string; sha1?: string | undefined },
) {
  return entry.sha1 ? `${templateId}@${version}/${entry.name}#${entry.sha1}` : null;
}

export async function cachedAssetBytes(
  templateId: string,
  version: string,
  entry: { name: string; sha1?: string | undefined },
  load: () => Promise<Uint8Array>,
): Promise<Uint8Array> {
  const key = keyOf(templateId, version, entry);
  if (key === null) return load();
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const bytes = await load();
  if (bytes.byteLength <= ASSET_CACHE_MAX_BYTES && !cache.has(key)) {
    cache.set(key, bytes);
    total += bytes.byteLength;
    for (const [oldKey, old] of cache) {
      if (total <= ASSET_CACHE_MAX_BYTES) break;
      cache.delete(oldKey);
      total -= old.byteLength;
    }
  }
  return bytes;
}

export function clearAssetCache(): void {
  cache.clear();
  total = 0;
}
