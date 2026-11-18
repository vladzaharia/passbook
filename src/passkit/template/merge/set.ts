import type { Json } from '../../types.ts';
import { canon, leaf, type Rule } from './map.ts';

/**
 * S3: set merge by canonical value. Adds and removes from both sides apply; the result keeps
 * ours' order with theirs' adds appended and has no duplicates.
 */
export const setOf: Rule = (cx, path, b, o, t) => {
  const keys = (v: Json[]) => new Set(v.map(canon));
  if (!(Array.isArray(o) && Array.isArray(t) && (Array.isArray(b) || cx.twoWay)))
    return leaf(cx, path, b, o, t);
  // Two-way has no base to tell an add from a remove: any difference is both-changed.
  if (cx.twoWay) {
    const [ko, kt] = [keys(o), keys(t)];
    return ko.size === kt.size && [...ko].every((k) => kt.has(k)) ? o : leaf(cx, path, b, o, t);
  }
  const [kb, kt] = [keys(Array.isArray(b) ? b : []), keys(t)];
  const out = new Map<string, Json>();
  for (const v of o) out.set(canon(v), v);
  for (const v of t)
    if (!kb.has(canon(v)) && !out.has(canon(v))) {
      out.set(canon(v), v);
      cx.changes.push({ part: cx.part, path, op: 'add' });
    }
  for (const k of kb)
    if (!kt.has(k) && out.delete(k)) cx.changes.push({ part: cx.part, path, op: 'remove' });
  return [...out.values()];
};
