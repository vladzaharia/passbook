import { beforeAll, describe, expect, it, vi } from 'vitest';
import { makeApiKey, makeSession } from '../../../../test/helpers/index.ts';
import { type ApiKeyAuthority, authorizeApiKeys } from '../api-keys/access.ts';
import { getKey } from '../api-keys/repo.ts';
import { revokeApiKey } from '../api-keys/service.ts';
import { revokeSession } from '../auth/repo-sessions.ts';
import { hashSessionCookie, resolveSession } from '../auth/sessions.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { grantKitMembership } from './apple-release-test-fixtures.ts';
import type { TenantPassWrite } from './http.ts';
import { putMemberPhoto, updateMemberPhoto } from './member-photo.ts';
import {
  actor,
  encoded,
  type MemberPhotoFixture,
  png,
  setupPhotoTestKit,
} from './member-photo-test-fixtures.ts';

import { tenantOrgUpdatedAt } from './repo-authority.ts';
import { memberPhoto } from './repo-member-photo.ts';
import { getPass } from './repo-read-pass.ts';
import type { PassScope } from './scope.ts';
import type { Actor } from './service.ts';

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

describe('member photo publication authority', () => {
  it.each(['session', 'api key'] as const)(
    'restores the photo if the %s is revoked before Wallet publication',
    async (kind) => {
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
      if (orgUpdatedAt === null) throw new Error('Organization snapshot is missing');
      let scope: PassScope;
      let authority: TenantPassWrite;
      let user: Actor;
      let revoke: () => Promise<boolean>;
      if (kind === 'session') {
        const session = await makeSession(kit.fx, { userId: 'admin-1', roles: ['admin', 'user'] });
        const sessionId = await hashSessionCookie(session.cookieValue);
        scope = { orgId: pass.orgId, mode: pass.mode, principal: 'session' };
        authority = {
          kind: 'session',
          orgId: pass.orgId,
          orgUpdatedAt,
          mode: pass.mode,
          userId: 'admin-1',
          sessionId,
          sessionRoles: ['admin', 'user'],
          amr: 'oidc',
          membershipId: adminMembershipId,
          roles: ['pass_operator'],
          capability: 'passes:operate',
        };
        user = { type: 'user', id: 'admin-1' };
        revoke = () => revokeSession(kit.env.DB, sessionId, kit.clock.now());
      } else {
        const key = await makeApiKey(kit.fx, { orgId: pass.orgId, scopes: ['passes:write'] });
        scope = { orgId: pass.orgId, mode: pass.mode, principal: 'api_key' };
        authority = {
          kind: 'api_key',
          orgId: pass.orgId,
          orgUpdatedAt,
          keyOrgId: pass.orgId,
          keyId: key.id,
          scopes: ['passes:write'],
          scope: 'passes:write',
          mode: pass.mode,
        };
        user = { type: 'api_key', id: key.id };
        revoke = async () => {
          await revokeApiKey(kit.ctx, keyAuthority, key.id);
          return (await getKey(kit.env.DB, key.id, pass.orgId))?.revoked_at === kit.clock.now();
        };
      }
      const resolve = kit.registry.resolve.bind(kit.registry);
      let calls = 0;
      let revoked = false;
      const spy = vi.spyOn(kit.registry, 'resolve').mockImplementation(async (...args) => {
        calls += 1;
        const current = (await getPass(kit.env.DB, pass.id))!;
        if (!revoked && current.linkGeneration === prior.linkGeneration + 1) {
          revoked = true;
          expect(await revoke()).toBe(true);
        }
        return resolve(...args);
      });
      try {
        await expect(
          updateMemberPhoto(kit.ctx, user, pass.id, true, scope, authority),
        ).rejects.toThrow();
      } finally {
        spy.mockRestore();
      }
      expect(calls).toBeGreaterThan(0);
      expect(revoked).toBe(true);
      expect(await memberPhoto(kit.env.DB, pass.orgId, pass.id)).toEqual(before);
      const after = (await getPass(kit.env.DB, pass.id))!;
      expect(after.linkGeneration).toBe(prior.linkGeneration + 2);
      expect(after.version).toBe(prior.version);
      expect(after.downloadToken).toBe(prior.downloadToken);
      const object = await kit.env.BUCKET.get(before.r2_key);
      expect(object).not.toBeNull();
      expect(new Uint8Array(await object!.arrayBuffer())).toEqual(png);
    },
  );
});
