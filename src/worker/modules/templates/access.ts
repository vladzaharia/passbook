import type { ApiKeyAuth, AuthContext } from '../../platform/auth.ts';
import { ForbiddenError, UnauthenticatedError } from '../../platform/errors.ts';
import { waiveFeature } from '../../platform/feature-guard.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { type TenantPassWrite, tenantAuthorityOf } from '../passes/http.ts';
import { loadUserAccessRevision } from '../passes/repo-access-revision.ts';
import { hasTemplateAuthority } from './repo-authority.ts';
import { creatorMembership, keyActor } from './repo-key-creator.ts';

export type PlatformSessionAuthority = {
  kind: 'platform';
  userId: string;
  sessionId: string;
  /** `users.access_revision` at upload: a queued import ends if the admin was disabled meanwhile. */
  userAccessRevision?: number;
};
/**
 * A Test-mode key acting as its creator: the template rows record `userId` as author or reviewer,
 * and the creator's membership must still grant `capability` wherever the authority is rechecked.
 */
export type KeyTemplateAuthority = Extract<TenantPassWrite, { kind: 'api_key' }> & {
  userId: string;
  membershipId: string;
  capability: TemplateCapability;
};
export type TemplateCapability = 'templates:author' | 'templates:review' | 'templates:publish';
export type TemplateAuthority =
  | Extract<TenantPassWrite, { kind: 'session' }>
  | PlatformSessionAuthority
  | KeyTemplateAuthority;

export const keyTestOnly = () =>
  new ForbiddenError('Only a Test key can do this. Use a person for Live.', 'KEY_TEST_ONLY');

/**
 * Authorize the actual destination organization, never a caller-supplied replacement for it.
 * `liveRequest` lets a Live key act as an author, to request review only (D3).
 */
export async function authorizeTemplateWrite(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  orgId: string | null,
  capability: TemplateCapability,
  options: { liveRequest?: boolean } = {},
): Promise<TemplateAuthority> {
  if (!auth) throw new UnauthenticatedError();
  if (auth.kind === 'api_key')
    return keyTemplateAuthority(ctx, auth, orgId, capability, options.liveRequest === true);
  if (auth.kind !== 'session') throw new ForbiddenError();
  if (orgId !== null) {
    const authority = await tenantAuthorityOf(ctx, auth, orgId, capability);
    if (authority.kind !== 'session') throw new ForbiddenError();
    return authority;
  }
  if (!auth.roles.includes('admin')) throw new ForbiddenError();
  // Platform-owned templates belong to no org, so a route's declared feature has nothing to check.
  waiveFeature(auth);
  const authority: PlatformSessionAuthority = {
    kind: 'platform',
    userId: auth.userId,
    sessionId: auth.sessionId,
    userAccessRevision: (await loadUserAccessRevision(ctx.env.DB, auth.userId)) ?? 0,
  };
  await assertTemplateAuthority(ctx, authority);
  return authority;
}

/**
 * Test-mode keys only: Live approval and release stay with people. The key acts as the member who
 * created it, so the same reviewer rules apply to that member's work.
 */
async function keyTemplateAuthority(
  ctx: ServiceContext,
  auth: ApiKeyAuth,
  orgId: string | null,
  capability: TemplateCapability,
  liveRequest: boolean,
): Promise<KeyTemplateAuthority> {
  if (
    orgId === null ||
    (auth.mode !== 'test' && !(liveRequest && capability === 'templates:author'))
  )
    throw keyTestOnly();
  const authority = await tenantAuthorityOf(ctx, auth, orgId, capability);
  if (authority.kind !== 'api_key') throw new ForbiddenError();
  const { userId, membershipId: named } = await keyActor(ctx.env.DB, auth.keyId);
  const membershipId =
    userId === null ? null : await creatorMembership(ctx.env.DB, orgId, userId, capability, named);
  if (userId === null || membershipId === null)
    throw new ForbiddenError(
      userId === null
        ? "The key's creator no longer exists. Create a new key."
        : "The key's creator is not a member of this organization who can do this. Create a new key.",
      userId === null ? 'KEY_CREATOR_GONE' : 'KEY_CREATOR_NOT_MEMBER',
    );
  return { ...authority, userId, membershipId, capability };
}

/** Recheck a captured grant immediately before a non-D1 side effect. */
export async function assertTemplateAuthority(
  ctx: ServiceContext,
  authority: TemplateAuthority,
  deferred = false,
): Promise<void> {
  if (!(await hasTemplateAuthority(ctx.env.DB, authority, ctx.clock.now(), deferred)))
    throw new ForbiddenError();
}

/** A key reaches the Apple release path only; Google and Samsung projections stay with people. */
export function keysApplyOnly(auth: AuthContext | undefined, provider: string): void {
  if (auth?.kind === 'api_key' && provider !== 'apple') throw new ForbiddenError();
}
