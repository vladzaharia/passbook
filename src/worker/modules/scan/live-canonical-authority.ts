// A D1 row is at most 2,000,000 bytes. Repeated raw/parsed row representations and worst-case
// JSON escaping bound this envelope even for deeply nested or unusually wide source documents.
export const MAX_D1_ROW_BYTES = 2_000_000;
const MAX_CANONICAL_CHARS = MAX_D1_ROW_BYTES * 36 + 65_536;

type CanonicalFrame =
  | { kind: 'array'; value: unknown[]; index: number }
  | { kind: 'object'; value: Record<string, unknown>; keys: string[]; index: number };

/** Equivalent to canonicalJson, but iterative so a D1-sized document cannot overflow the stack. */
export function canonicalAuthority(root: unknown): string | null {
  const chunks: string[] = [];
  const stack: CanonicalFrame[] = [];
  const ancestors = new WeakSet<object>();
  let chars = 0;
  const append = (chunk: string) => {
    chars += chunk.length;
    if (chars > MAX_CANONICAL_CHARS) throw new RangeError('Authority exceeds D1 bounds');
    chunks.push(chunk);
  };
  let current = root;
  let visiting = true;
  while (visiting || stack.length) {
    if (visiting) {
      if (current && typeof current === 'object') {
        if (ancestors.has(current) || Object.getOwnPropertySymbols(current).length > 0) return null;
        ancestors.add(current);
        if (Array.isArray(current)) {
          if (Object.getPrototypeOf(current) !== Array.prototype) return null;
          for (const key in current) {
            if (!Object.hasOwn(current, key)) continue;
            const index = Number(key);
            if (
              !Number.isSafeInteger(index) ||
              index < 0 ||
              index >= current.length ||
              String(index) !== key
            )
              return null;
          }
          append('[');
          stack.push({ kind: 'array', value: current, index: 0 });
        } else {
          const prototype = Object.getPrototypeOf(current);
          if (prototype !== Object.prototype && prototype !== null) return null;
          const value = current as Record<string, unknown>;
          const keys = Object.keys(value).sort();
          append('{');
          stack.push({ kind: 'object', value, keys, index: 0 });
        }
      } else {
        if (
          current !== null &&
          typeof current !== 'string' &&
          typeof current !== 'boolean' &&
          !(typeof current === 'number' && Number.isFinite(current))
        )
          return null;
        append(JSON.stringify(current));
      }
      visiting = false;
      continue;
    }
    const frame = stack[stack.length - 1];
    if (!frame) return null;
    const length = frame.kind === 'array' ? frame.value.length : frame.keys.length;
    if (frame.index === length) {
      append(frame.kind === 'array' ? ']' : '}');
      ancestors.delete(frame.value);
      stack.pop();
      continue;
    }
    if (frame.index > 0) append(',');
    if (frame.kind === 'array') {
      const property = Object.getOwnPropertyDescriptor(frame.value, frame.index++);
      if (!property || !('value' in property)) return null;
      current = property.value;
    } else {
      const key = frame.keys[frame.index++];
      if (key === undefined) return null;
      append(JSON.stringify(key));
      append(':');
      const property = Object.getOwnPropertyDescriptor(frame.value, key);
      if (!property || !('value' in property)) return null;
      current = property.value;
    }
    visiting = true;
  }
  return chunks.join('');
}
