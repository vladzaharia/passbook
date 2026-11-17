import type { TenantPassWrite } from './http.ts';

/**
 * Whether a caller may see the global email of a user account. A tenant sees the records of its own
 * org (a pass's holder_email), never `users.primary_email`, which can belong to another org's member
 * or link an alias to an account. Platform administrators may.
 */
export function seesAccountEmails(
  authority: TenantPassWrite | { kind: 'platform' } | undefined,
): boolean {
  return (
    authority?.kind === 'platform' ||
    (authority?.kind === 'session' && authority.sessionRoles.includes('admin'))
  );
}
