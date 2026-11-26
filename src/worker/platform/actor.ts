import type { Context } from 'hono';
import { verifiedPlatformScopeOf } from './auth-capability.ts';
import type { Check } from './authority-checks.ts';
import type { Mode, Principal } from './authority-principal.ts';
import type { AppBindings } from './context.ts';
import { UnauthenticatedError } from './errors.ts';

/**
 * Who acts, for every route a key shares with a person: the grant principal and checks, the audit actor, the name a
 * mail shows, and the limiter key. One answer from one place, so a service never re-derives it from a session.
 */
export interface Actor {
  /** The grant principal, built for the scope it acts in (platform, or one org). */
  principal: Principal;
  checks: Check[];
  actorType: 'user' | 'api_key';
  actorId: string;
  via: 'console' | 'api';
  /** The person behind it: the session's user, or null for a key. */
  userId: string | null;
  keyId: string | null;
  /** Who a mail names: the person, else the key's owner (the org, or PassBook for a platform key). */
  sender:
    | { kind: 'person'; userId: string }
    | { kind: 'org'; orgId: string }
    | { kind: 'platform' };
  /** Per-caller limiter key: `user:<id>` or `key:<id>`. */
  rateKey: string;
}

/**
 * A `platform` route's caller: a platform admin session, or a Platform key with the scope the gate verified. A
 * platform grant names no org, so a key's principal never carries one (`target.orgId` is the session's only).
 * 401 for anything the gate did not admit.
 */
export function platformActorOf(
  c: Context<AppBindings>,
  target: { orgId?: string; mode?: Mode } = {},
): Actor {
  const auth = c.var.auth;
  if (auth?.kind === 'session')
    return {
      principal: {
        kind: 'platform',
        userId: auth.userId,
        sessionIdHash: auth.sessionId,
        ...target,
      },
      checks: [],
      actorType: 'user',
      actorId: auth.userId,
      via: 'console',
      userId: auth.userId,
      keyId: null,
      sender: { kind: 'person', userId: auth.userId },
      rateKey: `user:${auth.userId}`,
    };
  const scope = auth?.kind === 'api_key' ? verifiedPlatformScopeOf(auth) : undefined;
  if (auth?.kind !== 'api_key' || !scope || auth.orgId !== null) throw new UnauthenticatedError();
  return {
    principal: { kind: 'api_key', keyId: auth.keyId, scope },
    checks: [],
    actorType: 'api_key',
    actorId: auth.keyId,
    via: 'api',
    userId: null,
    keyId: auth.keyId,
    sender: { kind: 'platform' },
    rateKey: `key:${auth.keyId}`,
  };
}
