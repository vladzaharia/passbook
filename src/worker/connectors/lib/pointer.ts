import type { Json } from '../../../shared/contracts/common.ts';

const POINTER = /^(?:\/(?:[^~/]|~[01])*)*$/;

/** Bare names are shorthand for a top-level key. */
export function normalizePointer(value: string): string {
  if (value === '' || value.startsWith('/')) return value;
  return `/${value.replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

export function isPointer(value: string): boolean {
  return POINTER.test(normalizePointer(value));
}

/** RFC 6901 lookup. Returns undefined when any segment is missing. */
export function getPointer(root: unknown, pointer: string): Json | undefined {
  const ptr = normalizePointer(pointer);
  if (ptr === '') return root as Json;
  let current: unknown = root;
  for (const raw of ptr.slice(1).split('/')) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/.test(key)) return undefined;
      current = current[Number(key)];
    } else if (current !== null && typeof current === 'object') {
      if (!Object.hasOwn(current, key)) return undefined;
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return current as Json | undefined;
}
