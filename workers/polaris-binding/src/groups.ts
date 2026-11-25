import { alert } from './ledger.ts';
import { failure, ok, type Req } from './pocket-http.ts';
import { refuse, sameSet } from './policy.ts';
import type { Registry } from './registry.ts';
import type { Routes } from './routes.ts';
import { IdpError } from './types.ts';

export interface Account {
  isAdmin: boolean;
  disabled: boolean;
  /** Every group id of the user, registered or not, in Polaris ID's order. */
  groups: string[];
}

const unexpected = (what: string) =>
  new IdpError('IDP_UPSTREAM', `Polaris ID returned an unexpected ${what}.`);

export async function readGroups(req: Req, r: Routes, subject: string): Promise<string[]> {
  const res = await req('GET', r.userGroups(subject));
  if (!ok(res)) throw failure(res);
  if (!Array.isArray(res.body)) throw unexpected('groups answer');
  return (res.body as { id?: unknown }[]).flatMap((g) => (typeof g?.id === 'string' ? [g.id] : []));
}

/** The user DTO. One without both flags is refused: unknown is not "not an admin". */
export async function readUser(
  req: Req,
  r: Routes,
  subject: string,
): Promise<Record<string, unknown> & { isAdmin: boolean; disabled: boolean }> {
  const res = await req('GET', r.user(subject));
  if (!ok(res)) throw failure(res);
  const u = res.body as Record<string, unknown> | null;
  if (u?.id !== subject || typeof u.isAdmin !== 'boolean' || typeof u.disabled !== 'boolean')
    throw unexpected('user');
  return u as Record<string, unknown> & { isAdmin: boolean; disabled: boolean };
}

/** The user and their group ids. */
export async function readAccount(req: Req, r: Routes, subject: string): Promise<Account> {
  const u = await readUser(req, r, subject);
  return { isAdmin: u.isAdmin, disabled: u.disabled, groups: await readGroups(req, r, subject) };
}

/**
 * Accounts the binding never edits, whichever way they got a group: Polaris ID admins, members of a protected
 * group (platform admins, users) and the key's own user. Adds also refuse a disabled account.
 */
export function assertEditable(
  account: Account,
  subject: string,
  registry: Registry,
  keySubject: string | null,
  adding: boolean,
): void {
  if (account.isAdmin) refuse('Polaris ID admin accounts cannot be changed here.');
  if (subject === keySubject) refuse('The binding key user cannot be changed here.');
  if (account.groups.some((g) => registry.protectedIds.includes(g)))
    refuse('Members of a protected group cannot be changed here.');
  if (adding && account.disabled) refuse('This Polaris ID account is disabled.');
}

/**
 * Writes the user's groups as exactly what was read, plus `addIds` and minus `removeIds`, then reads them back.
 * Polaris ID only replaces the whole list, so groups outside the registry are carried through untouched, in order.
 * A mismatch afterwards is drift: an alert, never a retry.
 */
export async function writeGroups(
  req: Req,
  r: Routes,
  subject: string,
  before: string[],
  addIds: string[],
  removeIds: string[],
): Promise<void> {
  const want = [...before.filter((id) => !removeIds.includes(id))];
  for (const id of addIds) if (!want.includes(id)) want.push(id);
  const res = await req('PUT', r.setUserGroups(subject), { userGroupIds: want });
  if (!ok(res)) throw failure(res);
  const after = await readGroups(req, r, subject);
  if (!sameSet(after, want)) {
    alert('error', 'binding.drift', { subject });
    throw new IdpError('IDP_DRIFT', 'Groups changed while they were being written.');
  }
}
