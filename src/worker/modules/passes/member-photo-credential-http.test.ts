import { beforeAll, describe, expect, it, vi } from 'vitest';
import { makeApiKey, makeSession } from '../../../../test/helpers/index.ts';
import { first } from '../../platform/db.ts';
import { type ApiKeyAuthority, authorizeApiKeys } from '../api-keys/access.ts';
import { getKey } from '../api-keys/repo.ts';
import { createApiKey, revokeApiKey } from '../api-keys/service.ts';
import { revokeSession } from '../auth/repo-sessions.ts';
import { hashSessionCookie, resolveSession } from '../auth/sessions.ts';
import { revokeMembership } from '../orgs/repo-members.ts';
import { grantKitMembership } from './apple-release-test-fixtures.ts';
import {
  encoded,
  type MemberPhotoFixture,
  setupPhotoTestKit,
} from './member-photo-test-fixtures.ts';
import { memberPhoto } from './repo-member-photo.ts';
import { getPass } from './repo-read-pass.ts';

let kit: MemberPhotoFixture['kit'];
let api: MemberPhotoFixture['api'];
let adminHeaders: MemberPhotoFixture['adminHeaders'];
let keyAuthority: ApiKeyAuthority;
beforeAll(async () => {
  ({ kit, api, adminHeaders } = await setupPhotoTestKit());
  const managerId = `photo-key-manager-${kit.ctx.ids.token(12)}`;
  await grantKitMembership(kit, kit.org.id, managerId, ['org_admin']); // delegates passes:write, which integration_admin cannot
  const managerSession = await makeSession(kit.fx, { userId: managerId });
  const managerAuth = await resolveSession(kit.env, kit.clock, managerSession.cookieValue);
  if (!managerAuth) throw new Error('Key manager session is missing');
  keyAuthority = await authorizeApiKeys(kit.ctx, managerAuth, kit.org.id, 'integrations:manage');
});

describe('member photo credential HTTP fence', () => {
  it.each(['session', 'api key', 'membership'] as const)(
    'rejects an upload when the %s is revoked after authorization',
    async (kind) => {
      const pass = await kit.pass();
      let headers: Record<string, string>;
      let alternateHeaders: Record<string, string> | undefined;
      let revoke: () => Promise<boolean>;
      if (kind === 'session') {
        const session = await makeSession(kit.fx, { userId: 'admin-1', roles: ['admin', 'user'] });
        const sessionId = await hashSessionCookie(session.cookieValue);
        headers = { ...session.headers, origin: 'https://wallet.test' };
        const alternate = await makeSession(kit.fx, {
          userId: 'admin-1',
          roles: ['admin', 'user'],
        });
        alternateHeaders = { ...alternate.headers, origin: 'https://wallet.test' };
        revoke = () => revokeSession(kit.env.DB, sessionId, kit.clock.now());
      } else if (kind === 'api key') {
        const key = await makeApiKey(kit.fx, { orgId: pass.orgId, scopes: ['passes:write'] });
        headers = key.headers;
        alternateHeaders = (
          await makeApiKey(kit.fx, { orgId: pass.orgId, scopes: ['passes:write'] })
        ).headers;
        revoke = async () => {
          await revokeApiKey(kit.ctx, keyAuthority, key.id);
          return (await getKey(kit.env.DB, key.id, pass.orgId))?.revoked_at === kit.clock.now();
        };
      } else {
        const userId = `photo-operator-${kit.ctx.ids.token(12)}`;
        const membershipId = await grantKitMembership(kit, pass.orgId, userId, ['pass_operator']);
        const session = await makeSession(kit.fx, { userId });
        headers = { ...session.headers, origin: 'https://wallet.test' };
        revoke = async () => {
          const result = await revokeMembership(
            kit.env.DB,
            pass.orgId,
            membershipId,
            kit.clock.now(),
            'admin-1',
            true,
          ).run();
          return (result.meta.changes ?? 0) > 0;
        };
      }
      const originalPut = kit.env.BUCKET.put.bind(kit.env.BUCKET);
      let uploadedKey = '';
      const spy = vi
        .spyOn(kit.env.BUCKET, 'put')
        .mockImplementation(async (key, value, options) => {
          const object = await originalPut(key, value, options);
          if (key.startsWith(`member-photos/${pass.orgId}/${pass.id}/`)) {
            uploadedKey = key;
            expect(await revoke()).toBe(true);
          }
          return object;
        });
      try {
        const response = await api(pass.id, 'PUT', { png: encoded, includeInPass: false }, headers);
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ code: 'FORBIDDEN' });
      } finally {
        spy.mockRestore();
      }
      expect(uploadedKey).not.toBe('');
      expect(await kit.env.BUCKET.get(uploadedKey)).toBeNull();
      expect(
        await first(kit.env.DB, 'SELECT 1 FROM pass_transfer_asset_gc WHERE r2_key = ?', [
          uploadedKey,
        ]),
      ).not.toBeNull();
      expect(await memberPhoto(kit.env.DB, pass.orgId, pass.id)).toBeNull();
      const after = (await getPass(kit.env.DB, pass.id))!;
      expect(after.linkGeneration).toBe(pass.linkGeneration);
      expect(after.downloadToken).toBe(pass.downloadToken);
      if (alternateHeaders) {
        const response = await api(
          pass.id,
          'PUT',
          { png: encoded, includeInPass: false },
          alternateHeaders,
        );
        expect(response.status).toBe(200);
      }
    },
  );

  it.each(['session', 'api key'] as const)(
    'rejects an upload when the %s expires during R2 storage',
    async (kind) => {
      const pass = await kit.pass();
      const now = kit.clock.now();
      let headers: Record<string, string>;
      let expiresAfter: number;
      if (kind === 'session') {
        const session = await makeSession(kit.fx, { userId: 'admin-1', roles: ['admin', 'user'] });
        headers = { ...session.headers, origin: 'https://wallet.test' };
        expiresAfter = 3_600_001;
      } else {
        const key = await createApiKey(kit.ctx, keyAuthority, {
          orgId: pass.orgId,
          name: 'Expiring photo key',
          scopes: ['passes:write'],
          mode: pass.mode,
          expiresAt: now + 10,
        });
        headers = { authorization: `Bearer ${key.secret}` };
        expiresAfter = 11;
      }
      const originalPut = kit.env.BUCKET.put.bind(kit.env.BUCKET);
      let uploadedKey = '';
      const spy = vi
        .spyOn(kit.env.BUCKET, 'put')
        .mockImplementation(async (key, value, options) => {
          const object = await originalPut(key, value, options);
          if (key.startsWith(`member-photos/${pass.orgId}/${pass.id}/`)) {
            uploadedKey = key;
            kit.clock.set(now + expiresAfter);
          }
          return object;
        });
      try {
        const response = await api(pass.id, 'PUT', { png: encoded, includeInPass: false }, headers);
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ code: 'FORBIDDEN' });
      } finally {
        kit.clock.set(now);
        spy.mockRestore();
      }
      expect(uploadedKey).not.toBe('');
      expect(await kit.env.BUCKET.get(uploadedKey)).toBeNull();
      expect(
        await first(kit.env.DB, 'SELECT 1 FROM pass_transfer_asset_gc WHERE r2_key = ?', [
          uploadedKey,
        ]),
      ).not.toBeNull();
      expect(await memberPhoto(kit.env.DB, pass.orgId, pass.id)).toBeNull();
      const after = (await getPass(kit.env.DB, pass.id))!;
      expect(after.linkGeneration).toBe(pass.linkGeneration);
      expect(after.downloadToken).toBe(pass.downloadToken);
    },
  );

  it.each(['session', 'api key'] as const)('accepts active %s photo writes', async (kind) => {
    const pass = await kit.pass();
    const headers =
      kind === 'session'
        ? adminHeaders
        : (await makeApiKey(kit.fx, { orgId: pass.orgId, scopes: ['passes:write'] })).headers;
    const response = await api(pass.id, 'PUT', { png: encoded, includeInPass: false }, headers);
    expect(response.status).toBe(200);
    expect(await memberPhoto(kit.env.DB, pass.orgId, pass.id)).not.toBeNull();
    const after = (await getPass(kit.env.DB, pass.id))!;
    expect(after.linkGeneration).toBe(pass.linkGeneration + 1);
    expect(after.downloadToken).toBe(pass.downloadToken);
  });
});
