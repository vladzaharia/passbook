/** A platform sign-in or account-linking setting (`auth.*`, `oidc.*`) decides who gets in: a person's change, never a key's. */
export function changesSignIn(values: unknown): boolean {
  return (
    typeof values === 'object' &&
    values !== null &&
    Object.keys(values).some((key) => key.startsWith('auth.') || key.startsWith('oidc.'))
  );
}

/** `key.unless` of the platform settings save: refuse unless the body provably names no sign-in key. */
export const needsPerson = (body: Record<string, unknown> | null): boolean =>
  body === null ||
  (body.values !== undefined &&
    (typeof body.values !== 'object' || body.values === null || changesSignIn(body.values)));
