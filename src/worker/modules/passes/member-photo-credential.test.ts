import { beforeAll, describe, expect, it } from 'vitest';
import { makeApiKey, makeOrg, makeSession } from '../../../../test/helpers/index.ts';
import { type ApiKeyAuthority, authorizeApiKeys } from '../api-keys/access.ts';
import { getKey } from '../api-keys/repo.ts';
import { createApiKey, revokeApiKey } from '../api-keys/service.ts';
import { revokeSession } from '../auth/repo-sessions.ts';
import { hashSessionCookie, resolveSession } from '../auth/sessions.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { setStatus } from '../users/repo.ts';
import { grantKitMembership } from './apple-release-test-fixtures.ts';
import type { TenantPassWrite } from './http.ts';
import { putMemberPhoto } from './member-photo.ts';
import {
  actor,
  encoded,
  type MemberPhotoFixture,
  setupPhotoTestKit,
} from './member-photo-test-fixtures.ts';

import { tenantOrgUpdatedAt } from './repo-authority.ts';
import { capturePassImageGeneration } from './repo-history-image.ts';
import { memberPhoto } from './repo-member-photo.ts';
import { replaceMemberPhotoGranted } from './repo-member-photo-grant.ts';
import { getPass } from './repo-read-pass.ts';

let kit: MemberPhotoFixture['kit'];
let adminMembershipId: string;
let keyAuthority: ApiKeyAuthority;
beforeAll(async () => {
  ({ kit, adminMembershipId } = await setupPhotoTestKit());
  const managerId = `photo-key-manager-${kit.ctx.ids.token(12)}`;
  await grantKitMembership(kit, kit.org.id, managerId, ['org_admin']); // delegates passes:write, which integration_admin cannot
  const managerSession = await makeSession(kit.fx, { userId: managerId });
  const managerAuth = await resolveSession(kit.env, kit.clock, managerSession.cookieValue);
  if (!managerAuth) throw new Error('Key manager session is missing');
  keyAuthority = await authorizeApiKeys(kit.ctx, managerAuth, kit.org.id, 'integrations:manage');
});

describe('member photo credential fence', () => {
  it.each([
    'revoked session',
    'expired session',
    'session mode mismatch',
    'disabled user',
    'read-only member',
    'revoked key',
    'expired key',
    'missing key scope',
    'wrong key scope',
    'key mode mismatch',
    'foreign key',
    'pass mode mismatch',
  ] as const)('does not mutate for %s', async (scenario) => {
    const pass = await kit.pass();
    await putMemberPhoto(
      jobCtxOf(kit),
      actor,
      pass.id,
      { png: encoded, includeInPass: false },
      null,
    );
    const before = (await memberPhoto(kit.env.DB, pass.orgId, pass.id))!;
    const prior = (await getPass(kit.env.DB, pass.id))!;
    const next = { ...before, version: kit.ctx.ids.token(16) };
    const orgUpdatedAt = await tenantOrgUpdatedAt(kit.env.DB, pass.orgId);
    const imageGeneration = await capturePassImageGeneration(kit.env.DB, prior, kit.clock.now());
    if (orgUpdatedAt === null || imageGeneration === null)
      throw new Error('Pass snapshot is missing');
    let authority: TenantPassWrite;
    let mode = pass.mode;
    const oppositeMode = pass.mode === 'live' ? 'test' : 'live';
    let now = kit.clock.now();
    if (
      scenario === 'revoked session' ||
      scenario === 'expired session' ||
      scenario === 'read-only member' ||
      scenario === 'disabled user' ||
      scenario === 'session mode mismatch'
    ) {
      const userId =
        scenario === 'read-only member' || scenario === 'disabled user'
          ? `photo-member-${kit.ctx.ids.token(12)}`
          : 'admin-1';
      let membershipId = adminMembershipId;
      if (scenario === 'read-only member')
        membershipId = await grantKitMembership(kit, pass.orgId, userId, ['read_only']);
      if (scenario === 'disabled user') {
        membershipId = await grantKitMembership(kit, pass.orgId, userId);
        await setStatus(kit.env.DB, userId, 'disabled', now);
      }
      const session = await makeSession(kit.fx, { userId });
      const sessionId = await hashSessionCookie(session.cookieValue);
      // The disabled-user case keeps a live credential row to isolate the user-status fence.
      if (scenario === 'revoked session')
        expect(await revokeSession(kit.env.DB, sessionId, now)).toBe(true);
      if (scenario === 'expired session') now += 3_600_001;
      if (scenario === 'session mode mismatch') mode = oppositeMode;
      authority = {
        kind: 'session',
        orgId: pass.orgId,
        orgUpdatedAt,
        mode,
        userId,
        sessionId,
        sessionRoles: ['user'],
        amr: 'oidc',
        membershipId,
        roles: scenario === 'read-only member' ? ['read_only'] : ['pass_operator'],
        capability: 'passes:operate',
      };
    } else {
      const orgId = scenario === 'foreign key' ? (await makeOrg(kit.fx)).id : pass.orgId;
      const scopes: ('passes:read' | 'passes:write')[] =
        scenario === 'missing key scope'
          ? ['passes:read']
          : scenario === 'wrong key scope'
            ? ['passes:read', 'passes:write']
            : ['passes:write'];
      let keyId: string;
      if (scenario === 'expired key' || scenario === 'pass mode mismatch') {
        const key = await createApiKey(kit.ctx, keyAuthority, {
          orgId,
          name: 'Photo credential test',
          scopes: ['passes:write'],
          mode: scenario === 'pass mode mismatch' ? oppositeMode : pass.mode,
          expiresAt: scenario === 'expired key' ? now + 10 : null,
        });
        keyId = key.id;
        if (scenario === 'expired key') now += 11;
      } else {
        const key = await makeApiKey(kit.fx, { orgId, scopes });
        keyId = key.id;
        if (scenario === 'revoked key') {
          await revokeApiKey(kit.ctx, keyAuthority, keyId);
          expect((await getKey(kit.env.DB, keyId, orgId))?.revoked_at).toBe(now);
        }
      }
      authority = {
        kind: 'api_key',
        orgId: pass.orgId,
        orgUpdatedAt,
        keyId,
        keyOrgId: orgId,
        scopes,
        scope: scenario === 'wrong key scope' ? 'passes:read' : 'passes:write',
        mode:
          scenario === 'key mode mismatch' || scenario === 'pass mode mismatch'
            ? oppositeMode
            : pass.mode,
      };
    }
    const wall = kit.clock.now();
    kit.clock.set(now);
    const result = await replaceMemberPhotoGranted(kit.ctx, next, before.version, {
      pass: prior,
      imageGeneration,
      authority,
    }).catch((error: unknown) => error);
    kit.clock.set(wall);
    expect(result instanceof Error || (result as { saved: boolean }).saved === false).toBe(true);
    expect(await memberPhoto(kit.env.DB, pass.orgId, pass.id)).toEqual(before);
    const after = (await getPass(kit.env.DB, pass.id))!;
    expect(after.linkGeneration).toBe(prior.linkGeneration);
    expect(after.downloadToken).toBe(prior.downloadToken);
    expect(await kit.env.BUCKET.get(before.r2_key)).not.toBeNull();
  });

  it('allows an active platform-wide API key without weakening its credential fence', async () => {
    const pass = await kit.pass();
    await putMemberPhoto(
      jobCtxOf(kit),
      actor,
      pass.id,
      { png: encoded, includeInPass: false },
      null,
    );
    const before = (await memberPhoto(kit.env.DB, pass.orgId, pass.id))!;
    const prior = (await getPass(kit.env.DB, pass.id))!;
    const orgUpdatedAt = await tenantOrgUpdatedAt(kit.env.DB, pass.orgId);
    const imageGeneration = await capturePassImageGeneration(kit.env.DB, prior, kit.clock.now());
    if (orgUpdatedAt === null || imageGeneration === null)
      throw new Error('Pass snapshot is missing');
    const key = await makeApiKey(kit.fx, { orgId: null, scopes: ['passes:write'] });
    const next = { ...before, version: kit.ctx.ids.token(16) };
    const result = await replaceMemberPhotoGranted(kit.ctx, next, before.version, {
      pass: prior,
      imageGeneration,
      authority: {
        kind: 'api_key',
        orgId: pass.orgId,
        orgUpdatedAt,
        keyId: key.id,
        keyOrgId: null,
        scopes: ['passes:write'],
        scope: 'passes:write',
        mode: pass.mode,
      },
    });
    expect(result.saved).toBe(true);
    expect(await memberPhoto(kit.env.DB, pass.orgId, pass.id)).toEqual(next);
    const after = (await getPass(kit.env.DB, pass.id))!;
    expect(after.linkGeneration).toBe(prior.linkGeneration + 1);
    expect(after.downloadToken).toBe(prior.downloadToken);
  });
});
