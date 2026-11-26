import { type GroupDto, parseGroup } from './group-dto.ts';
import { failure, ok, type Req } from './pocket-http.ts';
import { sameSet } from './policy.ts';
import type { Routes } from './routes.ts';
import type { Shared } from './shared.ts';
import { abandonIntent, insertIntent, setGroupLive } from './store-groups.ts';
import { IdpError, type WritableRole } from './types.ts';

/** Codes that mean the POST did not land: the pending intent is abandoned at once. */
const DEFINITE = ['IDP_CONFLICT', 'IDP_AUTH', 'IDP_NOT_FOUND', 'IDP_FROZEN', 'IDP_MISCONFIGURED'];

/** POSTs a group and reads it back. The intent row exists already; a definite failure abandons it. */
export async function postGroup(
  s: Pick<Shared, 'db'> & { r: Routes },
  req: Req,
  key: string,
  name: string,
  friendlyName: string,
): Promise<GroupDto> {
  let res: Awaited<ReturnType<Req>>;
  try {
    res = await req('POST', s.r.groups, { name, friendlyName });
    if (!ok(res)) throw failure(res);
  } catch (error) {
    if (error instanceof IdpError && DEFINITE.includes(error.code)) await abandonIntent(s.db, key);
    throw error;
  }
  const created = parseGroup(res.body);
  const back = await req('GET', s.r.group(created.id));
  if (!ok(back)) throw failure(back);
  const g = parseGroup(back.body);
  if (g.id !== created.id || g.name !== name || g.friendlyName !== friendlyName)
    throw new IdpError('IDP_DRIFT', 'The group did not come back as created.');
  return g;
}

/**
 * Makes a configured role group: intent, POST, read back, then the PassBook client allowed on it (union, never
 * replace: the client must allow the group or its members could not sign in), read back, live.
 */
export async function createRoleGroup(
  s: Shared,
  req: Req,
  role: WritableRole,
  want: { name: string; friendlyName: string },
  ref: string,
): Promise<void> {
  await insertIntent(s.db, {
    key: role,
    kind: 'role',
    name: want.name,
    friendly: want.friendlyName,
    ref,
    at: s.deps.now(),
  });
  const g = await postGroup(s, req, role, want.name, want.friendlyName);
  const clients = [...new Set([...g.clients, s.env.PASSBOOK_CLIENT_ID])];
  const put = await req('PUT', s.r.groupClients(g.id), { oidcClientIds: clients });
  if (!ok(put)) throw failure(put);
  const back = await req('GET', s.r.group(g.id));
  if (!ok(back)) throw failure(back);
  if (!sameSet(parseGroup(back.body).clients, clients))
    throw new IdpError('IDP_DRIFT', 'The group clients did not come back as written.');
  await setGroupLive(s.db, role, g.id);
}
