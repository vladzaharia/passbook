import type { SearchIndex } from './types.ts';

/** Read first when the index has it: the codes, paths and operations a new reader meets first. */
const PREFER = { code: 'INVALID_INPUT', method: 'POST', path: '/passes' } as const;

/** One error code, one path and one operation that exist in the index, for a search that found nothing. */
export function suggestions(index: SearchIndex): string[] {
  const code = (index.errors.find((e) => e.code === PREFER.code) ?? index.errors[0])?.code;
  const op =
    index.ops.find((o) => o.method === PREFER.method && o.path === PREFER.path) ?? index.ops[0];
  return [code, op?.path, op?.id].filter((s): s is string => !!s);
}
