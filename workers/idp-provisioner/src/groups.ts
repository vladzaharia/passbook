import { alert } from './ledger.ts';
import { failure, ok, type Req } from './pocket-http.ts';
import { refuse, sameSet } from './policy.ts';
import type { Routes } from './routes.ts';
import { IdpError } from './types.ts';

export interface Account {
  isAdmin: boolean;
  disabled: boolean;
  groups: string[];
}

async function readGroups(req: Req, r: Routes, subject: string): Promise<string[]> {
  const res = await req('GET', r.userGroups(subject));
  if (!ok(res)) throw failure(res);
  if (!Array.isArray(res.body))
    throw new IdpError('IDP_UPSTREAM', 'Pocket ID returned unexpected groups.');
  return (res.body as { id?: unknown }[]).flatMap((g) => (typeof g?.id === 'string' ? [g.id] : []));
}

/** The user and their group ids. A user DTO without both flags is refused: unknown is not "not an admin". */
export async function readAccount(req: Req, r: Routes, subject: string): Promise<Account> {
  const res = await req('GET', r.user(subject));
  if (!ok(res)) throw failure(res);
  const u = res.body as { id?: unknown; isAdmin?: unknown; disabled?: unknown } | null;
  if (u?.id !== subject || typeof u.isAdmin !== 'boolean' || typeof u.disabled !== 'boolean')
    throw new IdpError('IDP_UPSTREAM', 'Pocket ID returned an unexpected user.');
  return { isAdmin: u.isAdmin, disabled: u.disabled, groups: await readGroups(req, r, subject) };
}

/** Pocket ID admins are never edited here, whichever way the account got its group. */
export function assertEditable(account: Account, allowDisabled: boolean): void {
  if (account.isAdmin) refuse('Pocket ID admin accounts cannot be changed here.');
  if (account.disabled && !allowDisabled) refuse('This Pocket ID account is disabled.');
}

/**
 * Writes the user's groups as exactly what was read, plus or minus the developers group, then reads them back.
 * Pocket ID only replaces the whole list, so a mismatch afterwards is drift: an alert, never a retry.
 */
export async function writeGroups(
  req: Req,
  r: Routes,
  subject: string,
  before: string[],
  groupId: string,
  add: boolean,
): Promise<void> {
  const want = add ? [...new Set([...before, groupId])] : before.filter((id) => id !== groupId);
  const res = await req('PUT', r.setUserGroups(subject), { userGroupIds: want });
  if (!ok(res)) throw failure(res);
  const after = await readGroups(req, r, subject);
  if (!sameSet(after, want)) {
    alert('error', 'provisioner.drift', { subject });
    throw new IdpError('IDP_DRIFT', 'Groups changed while they were being written.');
  }
}
