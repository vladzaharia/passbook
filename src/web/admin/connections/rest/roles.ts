import type { FormValues } from '../../passes/schema-form/index.ts';
import { DEFAULT_ID, DEFAULT_RECORDS, KEY, readPagination, str } from './rest-values.ts';

/** The roles a node has been picked for: the first record stands for all of them. */
export function rolesOf(v: FormValues, updated: string | undefined): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const add = (p: string, role: string) => map.set(p, [...(map.get(p) ?? []), role]);
  const records = str(v[KEY.records], DEFAULT_RECORDS);
  add(records, 'Records');
  const first = `${records}/0`;
  add(`${first}${str(v[KEY.id], DEFAULT_ID)}`, 'ID');
  if (updated) add(`${first}${updated}`, 'Updated');
  if (v[KEY.email]) add(`${first}${str(v[KEY.email])}`, 'Email');
  const p = readPagination(v);
  if (p.style === 'cursor') {
    if (p.from === 'body' && p.cursorPointer) add(p.cursorPointer, 'Cursor');
    if (p.hasMorePointer) add(p.hasMorePointer, 'Has more');
  }
  if (p.style === 'next-link' && p.nextPointer) add(p.nextPointer, 'Next link');
  if (p.style === 'page' && p.totalPagesPointer) add(p.totalPagesPointer, 'Total');
  if (p.style === 'offset' && p.totalPointer) add(p.totalPointer, 'Total');
  return map;
}
