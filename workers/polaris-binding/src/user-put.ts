import { readUser } from './groups.ts';
import { alert } from './ledger.ts';
import { failure, ok, type Req } from './pocket-http.ts';
import { refuse } from './policy.ts';
import type { Routes } from './routes.ts';
import { IdpError } from './types.ts';

/**
 * The user fields `PUT /users/{id}` replaces. Polaris ID takes one DTO for the profile and for `isAdmin`,
 * `emailVerified` and `disabled`, so disabling means sending every field back as read.
 */
export const PUT_FIELDS = [
  'username',
  'email',
  'emailVerified',
  'firstName',
  'lastName',
  'displayName',
  'isAdmin',
  'locale',
  'disabled',
] as const;

/** The echo body: every field of the read, `disabled` replaced. A missing field is no write at all. */
export function echoBody(
  user: Record<string, unknown>,
  disabled: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const f of PUT_FIELDS) {
    if (!(f in user)) throw new IdpError('IDP_UPSTREAM', 'Polaris ID returned an incomplete user.');
    body[f] = user[f];
  }
  body.disabled = disabled;
  return body;
}

/**
 * Reads the user again right before the write, sends the echo, reads once more and compares every key of that
 * read except `disabled`, which must be the wanted value. A difference is drift, never retried; an account that
 * became an admin since the first read is refused before any write.
 */
export async function putDisabled(
  req: Req,
  r: Routes,
  subject: string,
  disabled: boolean,
): Promise<void> {
  const fresh = await readUser(req, r, subject);
  if (fresh.isAdmin) refuse('Polaris ID admin accounts cannot be changed here.');
  const body = echoBody(fresh, disabled);
  const res = await req('PUT', r.user(subject), body);
  if (!ok(res)) throw failure(res);
  const after = await readUser(req, r, subject);
  const keys = new Set([...Object.keys(fresh), ...Object.keys(after)]);
  keys.delete('disabled');
  const same = [...keys].every(
    (k) => JSON.stringify(after[k] ?? null) === JSON.stringify(fresh[k] ?? null),
  );
  if (!same || after.disabled !== disabled) {
    alert('error', 'binding.drift', { subject });
    throw new IdpError('IDP_DRIFT', 'The account changed while it was being written.');
  }
}
