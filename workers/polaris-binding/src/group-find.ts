import { unexpected } from './group-dto.ts';
import { failure, ok, type Req } from './pocket-http.ts';
import { ID } from './registry.ts';
import type { Routes } from './routes.ts';
import { IdpError } from './types.ts';

/** Groups that exist in Polaris ID under an exact name. Names are unique there, so at most one. */
export async function exactHit(r: Routes, req: Req, name: string): Promise<string | null> {
  const ids: string[] = [];
  for (let page = 1; page <= 3; page++) {
    const res = await req('GET', r.groupSearch(name, page));
    if (!ok(res)) throw failure(res);
    const data = (res.body as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) throw unexpected();
    for (const g of data as { id?: unknown; name?: unknown }[]) {
      if (typeof g?.id !== 'string' || !ID.test(g.id) || typeof g.name !== 'string')
        throw unexpected();
      if (g.name === name) ids.push(g.id);
    }
    if (data.length < 100) break;
  }
  if (ids.length > 1) throw new IdpError('IDP_CONFLICT', 'The group name is not unique.');
  return ids[0] ?? null;
}

/** The ids of the alias groups that exist. An alias that does not exist yet is simply absent. */
export async function aliasIds(r: Routes, req: Req, names: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const name of names) {
    const id = await exactHit(r, req, name);
    if (id !== null) out.push(id);
  }
  return out;
}
