import { beforeAll, describe, expect, it, vi } from 'vitest';
import { makeOrg, makeSession } from '../../../../test/helpers/index.ts';
import { hashSessionCookie } from '../auth/sessions.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { revokeMembership } from '../orgs/repo-members.ts';
import { grantKitMembership } from './apple-release-test-fixtures.ts';
import type { TenantPassWrite } from './http.ts';
import { deleteMemberPhoto, putMemberPhoto, updateMemberPhoto } from './member-photo.ts';
import {
  actor,
  encoded,
  type MemberPhotoFixture,
  png,
  setupPhotoTestKit,
} from './member-photo-test-fixtures.ts';
import { tenantOrgUpdatedAt } from './repo-authority.ts';
import { capturePassImageGeneration } from './repo-history-image.ts';
import { type MemberPhotoRow, memberPhoto } from './repo-member-photo.ts';
import { replaceMemberPhotoGranted } from './repo-member-photo-grant.ts';
import { getPass } from './repo-read-pass.ts';

let kit: MemberPhotoFixture['kit'];
let adminMembershipId: string;
beforeAll(async () => {
  ({ kit, adminMembershipId } = await setupPhotoTestKit());
});

describe('member photo tenant authority', () => {
  it.each(['insert', 'replace', 'update', 'delete'] as const)(
    'rejects a %s when authority is revoked before the photo CAS',
    async (operation) => {
      const pass = await kit.pass();
      if (operation !== 'insert') {
        await putMemberPhoto(
          jobCtxOf(kit),
          actor,
          pass.id,
          { png: encoded, includeInPass: false },
          null,
        );
      }
      const before = await memberPhoto(kit.env.DB, pass.orgId, pass.id);
      const prior = (await getPass(kit.env.DB, pass.id))!;
      const orgUpdatedAt = await tenantOrgUpdatedAt(kit.env.DB, pass.orgId);
      if (orgUpdatedAt === null) throw new Error('Organization snapshot is missing');
      const userId = `photo-${kit.ctx.ids.token(12)}`;
      const membershipId = await grantKitMembership(kit, pass.orgId, userId);
      const session = await makeSession(kit.fx, { userId });
      const sessionId = await hashSessionCookie(session.cookieValue);
      const scope = { orgId: pass.orgId, mode: pass.mode, principal: 'session' as const };
      const authority: TenantPassWrite = {
        kind: 'session' as const,
        orgId: pass.orgId,
        orgUpdatedAt,
        mode: pass.mode,
        userId,
        sessionId,
        sessionRoles: ['user'],
        amr: 'oidc',
        membershipId,
        roles: ['pass_operator'],
        capability: 'passes:operate' as const,
      };
      const user = { type: 'user' as const, id: userId };
      let revoked = false;
      const db = new Proxy(kit.env.DB, {
        get(target, property) {
          if (property === 'batch')
            return async (statements: D1PreparedStatement[]) => {
              if (!revoked) {
                revoked = true;
                const result = await revokeMembership(
                  kit.env.DB,
                  pass.orgId,
                  membershipId,
                  kit.clock.now(),
                  'admin-1',
                  true,
                ).run();
                expect(result.meta.changes).toBe(1);
                await grantKitMembership(kit, pass.orgId, userId);
              }
              return target.batch(statements);
            };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const ctx = { ...kit.ctx, env: { ...kit.env, DB: db } };
      const originalPut = kit.env.BUCKET.put.bind(kit.env.BUCKET);
      let uploadedKey: string | undefined;
      const spy = vi
        .spyOn(kit.env.BUCKET, 'put')
        .mockImplementation(async (key, value, options) => {
          if (key.startsWith(`member-photos/${pass.orgId}/${pass.id}/`)) uploadedKey = key;
          return originalPut(key, value, options);
        });
      try {
        const pending =
          operation === 'delete'
            ? deleteMemberPhoto(ctx, user, pass.id, scope, authority)
            : operation === 'update'
              ? updateMemberPhoto(ctx, user, pass.id, false, scope, authority)
              : putMemberPhoto(
                  ctx,
                  user,
                  pass.id,
                  { png: encoded, includeInPass: false },
                  scope,
                  authority,
                );
        await expect(pending).rejects.toMatchObject({ status: 403 });
      } finally {
        spy.mockRestore();
      }
      expect(revoked).toBe(true);
      expect(await memberPhoto(kit.env.DB, pass.orgId, pass.id)).toEqual(before);
      const after = (await getPass(kit.env.DB, pass.id))!;
      expect(after.linkGeneration).toBe(prior.linkGeneration);
      expect(after.downloadToken).toBe(prior.downloadToken);
      if (before) {
        const object = await kit.env.BUCKET.get(before.r2_key);
        expect(object).not.toBeNull();
        expect(new Uint8Array(await object!.arrayBuffer())).toEqual(png);
      }
      if (operation === 'insert' || operation === 'replace') {
        expect(uploadedKey).toBeDefined();
        expect(await kit.env.BUCKET.get(uploadedKey!)).toBeNull();
      }
    },
  );

  it.each(['put', 'update', 'delete'] as const)(
    'restores a failed Wallet %s after the initiating membership is revoked',
    async (operation) => {
      const pass = await kit.pass();
      await putMemberPhoto(
        jobCtxOf(kit),
        actor,
        pass.id,
        { png: encoded, includeInPass: operation === 'delete' },
        null,
      );
      const before = (await memberPhoto(kit.env.DB, pass.orgId, pass.id))!;
      const prior = (await getPass(kit.env.DB, pass.id))!;
      const orgUpdatedAt = await tenantOrgUpdatedAt(kit.env.DB, pass.orgId);
      if (orgUpdatedAt === null) throw new Error('Organization snapshot is missing');
      const userId = `photo-${kit.ctx.ids.token(12)}`;
      const membershipId = await grantKitMembership(kit, pass.orgId, userId);
      const session = await makeSession(kit.fx, { userId });
      const sessionId = await hashSessionCookie(session.cookieValue);
      const scope = { orgId: pass.orgId, mode: pass.mode, principal: 'session' as const };
      const authority: TenantPassWrite = {
        kind: 'session' as const,
        orgId: pass.orgId,
        orgUpdatedAt,
        mode: pass.mode,
        userId,
        sessionId,
        sessionRoles: ['user'],
        amr: 'oidc',
        membershipId,
        roles: ['pass_operator'],
        capability: 'passes:operate' as const,
      };
      const user = { type: 'user' as const, id: userId };
      const resolve = kit.registry.resolve.bind(kit.registry);
      let calls = 0;
      let during: MemberPhotoRow | null | undefined;
      let revoked = false;
      const spy = vi.spyOn(kit.registry, 'resolve').mockImplementation(async (...args) => {
        calls += 1;
        const current = (await getPass(kit.env.DB, pass.id))!;
        if (!revoked && current.linkGeneration === prior.linkGeneration + 1) {
          revoked = true;
          during = await memberPhoto(kit.env.DB, pass.orgId, pass.id);
          const result = await revokeMembership(
            kit.env.DB,
            pass.orgId,
            membershipId,
            kit.clock.now(),
            'admin-1',
            true,
          ).run();
          expect(result.meta.changes).toBe(1);
        }
        return resolve(...args);
      });
      try {
        const pending =
          operation === 'delete'
            ? deleteMemberPhoto(kit.ctx, user, pass.id, scope, authority)
            : operation === 'update'
              ? updateMemberPhoto(kit.ctx, user, pass.id, true, scope, authority)
              : putMemberPhoto(
                  kit.ctx,
                  user,
                  pass.id,
                  { png: encoded, includeInPass: true },
                  scope,
                  authority,
                );
        await expect(pending).rejects.toThrow();
      } finally {
        spy.mockRestore();
      }
      expect(calls).toBeGreaterThan(0);
      expect(revoked).toBe(true);
      expect(await memberPhoto(kit.env.DB, pass.orgId, pass.id)).toEqual(before);
      const after = (await getPass(kit.env.DB, pass.id))!;
      expect(after.linkGeneration).toBe(prior.linkGeneration + 2);
      expect(after.downloadToken).toBe(prior.downloadToken);
      const object = await kit.env.BUCKET.get(before.r2_key);
      expect(object).not.toBeNull();
      expect(new Uint8Array(await object!.arrayBuffer())).toEqual(png);
      if (operation === 'put') {
        expect(during).not.toBeNull();
        expect(during!.r2_key).not.toBe(before.r2_key);
        expect(await kit.env.BUCKET.get(during!.r2_key)).toBeNull();
      }
      if (operation === 'delete') expect(during).toBeNull();
    },
  );

  it('requires the authority organization to match the photo pass', async () => {
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
    const imageGeneration = await capturePassImageGeneration(kit.env.DB, prior, kit.clock.now());
    const orgUpdatedAt = await tenantOrgUpdatedAt(kit.env.DB, pass.orgId);
    if (imageGeneration === null || orgUpdatedAt === null)
      throw new Error('Pass snapshot is missing');
    const foreign = await makeOrg(kit.fx);
    const foreignOrgUpdatedAt = await tenantOrgUpdatedAt(kit.env.DB, foreign.id);
    if (foreignOrgUpdatedAt === null) throw new Error('Organization snapshot is missing');
    const foreignMembershipId = await grantKitMembership(kit, foreign.id);
    const session = await makeSession(kit.fx, { userId: 'admin-1', roles: ['admin', 'user'] });
    const sessionId = await hashSessionCookie(session.cookieValue);
    const next = { ...before, version: kit.ctx.ids.token(16) };
    const authority: TenantPassWrite = {
      kind: 'session',
      orgId: foreign.id,
      orgUpdatedAt: foreignOrgUpdatedAt,
      mode: pass.mode,
      userId: 'admin-1',
      sessionId,
      sessionRoles: ['admin', 'user'],
      amr: 'oidc',
      membershipId: foreignMembershipId,
      roles: ['pass_operator'],
      capability: 'passes:operate',
    };
    const foreignResult = await replaceMemberPhotoGranted(kit.ctx, next, before.version, {
      pass: prior,
      imageGeneration,
      authority,
    });
    expect(foreignResult.saved).toBe(false);
    expect(await memberPhoto(kit.env.DB, pass.orgId, pass.id)).toEqual(before);
    expect((await getPass(kit.env.DB, pass.id))!.linkGeneration).toBe(prior.linkGeneration);
    const localResult = await replaceMemberPhotoGranted(kit.ctx, next, before.version, {
      pass: prior,
      imageGeneration,
      authority: {
        ...authority,
        orgId: pass.orgId,
        orgUpdatedAt,
        membershipId: adminMembershipId,
      },
    });
    expect(localResult.saved).toBe(true);
    expect(await memberPhoto(kit.env.DB, pass.orgId, pass.id)).toEqual(next);
    expect((await getPass(kit.env.DB, pass.id))!.linkGeneration).toBe(prior.linkGeneration + 1);
  });
});
