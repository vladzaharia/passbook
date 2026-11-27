import { SAMPLE_BODY } from '../../../shared/webhook-setup/snippets.ts';

type Json = string | boolean | Json[] | { [key: string]: Json };

/** The pointers that say where a custom connection reads its body. */
interface PayloadPointers {
  recordsPointer: string;
  refPointer: string;
  recordPointer: string;
  deletedPointer: string;
  eventIdPointer: string;
}

const DEFAULT_POINTERS: PayloadPointers = {
  recordsPointer: '/records',
  refPointer: '/ref',
  recordPointer: '/record',
  deletedPointer: '/deleted',
  eventIdPointer: '/id',
};

const segments = (pointer: string): string[] | undefined =>
  pointer.startsWith('/') && pointer.length > 1
    ? pointer
        .slice(1)
        .split('/')
        .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
    : undefined;

function put(root: { [key: string]: Json }, pointer: string, value: Json): void {
  const path = segments(pointer);
  if (!path || path.some((s) => s === '__proto__' || s === 'constructor' || s === 'prototype'))
    return;
  let at = root;
  for (const key of path.slice(0, -1)) {
    const next = at[key];
    if (typeof next === 'object' && next !== null && !Array.isArray(next)) at = next;
    else {
      const made: { [key: string]: Json } = {};
      at[key] = made;
      at = made;
    }
  }
  const last = path[path.length - 1];
  if (last !== undefined) at[last] = value;
}

/** What a request must look like for these pointers: one record, with its id and the record. */
export function exampleBody(config: Record<string, unknown>, pretty = false): string {
  const pick = (key: keyof PayloadPointers) =>
    typeof config[key] === 'string' && config[key]
      ? (config[key] as string)
      : DEFAULT_POINTERS[key];
  const item: { [key: string]: Json } = {};
  put(item, pick('refPointer'), 'm-001');
  put(item, pick('recordPointer'), { name: 'Maya Chen' });
  put(item, pick('deletedPointer'), false);
  const root: { [key: string]: Json } = {};
  put(root, pick('eventIdPointer'), 'evt-1');
  put(root, pick('recordsPointer'), [item]);
  if (Object.keys(root).length === 0) return SAMPLE_BODY;
  return pretty ? JSON.stringify(root, null, 2) : JSON.stringify(root);
}
