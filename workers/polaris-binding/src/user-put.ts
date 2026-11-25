import { readUser } from './groups.ts';
import { alert } from './ledger.ts';
import { failure, ok, type Req } from './pocket-http.ts';
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

/** Sends the echo, reads the user again and compares every echoed field. A difference is drift, never retried. */
export async function putDisabled(
  req: Req,
  r: Routes,
  subject: string,
  user: Record<string, unknown>,
  disabled: boolean,
): Promise<void> {
  const body = echoBody(user, disabled);
  const res = await req('PUT', r.user(subject), body);
  if (!ok(res)) throw failure(res);
  const after = await readUser(req, r, subject);
  if (
    PUT_FIELDS.some((f) => JSON.stringify(after[f] ?? null) !== JSON.stringify(body[f] ?? null))
  ) {
    alert('error', 'binding.drift', { subject });
    throw new IdpError('IDP_DRIFT', 'The account changed while it was being written.');
  }
}
