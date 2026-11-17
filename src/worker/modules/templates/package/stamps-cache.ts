/** A map bounded by the bytes of its values; the least recently used go first. */
export function byteLru<V>(maxBytes: number, sizeOf: (value: V) => number) {
  const entries = new Map<string, { value: V; bytes: number }>();
  let total = 0;
  return {
    get(key: string): V | undefined {
      const hit = entries.get(key);
      if (!hit) return undefined;
      entries.delete(key);
      entries.set(key, hit);
      return hit.value;
    },
    set(key: string, value: V): void {
      const old = entries.get(key);
      if (old) total -= old.bytes;
      entries.delete(key);
      const bytes = sizeOf(value);
      if (bytes > maxBytes) return;
      entries.set(key, { value, bytes });
      total += bytes;
      for (const [k, e] of entries) {
        if (total <= maxBytes) break;
        entries.delete(k);
        total -= e.bytes;
      }
    },
    get bytes() {
      return total;
    },
    get size() {
      return entries.size;
    },
  };
}
