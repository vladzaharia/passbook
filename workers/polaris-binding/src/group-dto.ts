import { ID } from './registry.ts';
import { IdpError } from './types.ts';

export const unexpected = () =>
  new IdpError('IDP_UPSTREAM', 'Polaris ID returned an unexpected group.');
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
/** A client or claim entry without its string id or key fails the read: it is not "no entry". */
function strict(v: unknown): string {
  if (typeof v !== 'string') throw unexpected();
  return v;
}

export interface GroupDto {
  id: string;
  name: string;
  friendlyName: string | null;
  users: unknown[];
  clients: string[];
  claimKeys: string[];
  ldap: boolean;
}

/** A group DTO, strictly: a missing `users`, `allowedOidcClients` or `customClaims` fails the call, never reads as empty. */
export function parseGroup(body: unknown): GroupDto {
  const g = body as Record<string, unknown> | null;
  const clients = g?.allowedOidcClients;
  const claims = g?.customClaims;
  if (
    !g ||
    typeof g.id !== 'string' ||
    !ID.test(g.id) ||
    typeof g.name !== 'string' ||
    !Array.isArray(g.users) ||
    !Array.isArray(clients) ||
    !Array.isArray(claims)
  )
    throw unexpected();
  return {
    id: g.id,
    name: g.name,
    friendlyName: str(g.friendlyName),
    users: g.users,
    clients: clients.map((c) => strict((c as { id?: unknown })?.id)),
    claimKeys: claims.map((c) => strict((c as { key?: unknown })?.key)),
    ldap: typeof g.ldapId === 'string' && g.ldapId !== '',
  };
}
