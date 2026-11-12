import { beforeEach, describe, expect, it } from 'vitest';
import {
  fakeRateLimiter,
  makeApiKey,
  makeScanner,
  makeSession,
  makeUser,
} from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { first } from '../../platform/db.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { createScannerStore } from './auth-store.ts';
import {
  createPreviewAuthorityFixture,
  type PreviewAuthorityFixture,
} from './routes-display-authority-split-fixture.ts';
import { grantScanMembership } from './test-kit.ts';

let fixture: PreviewAuthorityFixture;

beforeEach(async () => {
  fixture = await createPreviewAuthorityFixture();
});

describe('scan display preview tenant authorization', () => {
  it('does not bootstrap credential authority for a nonmember or a member without pass read', async () => {
    const { env, f, own, memberSession, preview, previewAudits } = fixture;
    expect(
      await first(env.DB, 'SELECT commitment FROM credential_ref_keyset WHERE id = 1'),
    ).toBeNull();
    const outsider = await makeUser(f);
    const noMembership = await makeSession(f, { userId: outsider.id });
    const noPassRead = await memberSession(['integration_admin']);
    for (const [session, status] of [
      [noMembership, 404],
      [noPassRead, 403],
    ] as const) {
      const response = await preview(own, session.headers);
      expect(response.status).toBe(status);
      expect(await response.text()).not.toContain('Alex Morgan');
      expect(await previewAudits(session.userId)).toEqual([]);
      expect(
        await first(env.DB, 'SELECT commitment FROM credential_ref_keyset WHERE id = 1'),
      ).toBeNull();
    }
  });

  it('does not treat a platform administrator as a tenant member', async () => {
    const { f, own, preview, problem, previewAudits } = fixture;
    const user = await makeUser(f);
    const session = await makeSession(f, { userId: user.id, roles: ['admin', 'user'] });
    const denied = await preview(own, session.headers);
    const unknown = await preview({ ...own, passId: f.ids.id() }, session.headers);
    expect(denied.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await problem(denied)).toEqual(await problem(unknown));
    expect(denied.headers.get('cache-control')).toContain('no-store');
    expect(await previewAudits(user.id)).toEqual([]);
  });

  it('keeps real API keys and scanner principals off the session-only preview', async () => {
    const { env, clock, f, org, own, preview } = fixture;
    Object.assign(env, { RL_API_KEY: fakeRateLimiter({ limit: 100 }) });
    const keys = createApiKeyStore(env, clock);
    const scanners = createScannerStore(env, clock);
    const key = await makeApiKey(f, { orgId: org.id, scopes: ['templates:read', 'scans:read'] });
    const terminal = await makeScanner(f, { orgId: org.id, kind: 'terminal' });
    const device = await makeScanner(f, { orgId: org.id, kind: 'device' });
    expect(await keys.resolve(key.secret)).toMatchObject({ kind: 'api_key', orgId: org.id });
    expect(await scanners.resolve(terminal.token, 'bearer')).toMatchObject({ kind: 'scanner' });
    expect(await scanners.resolve(device.token, 'cookie')).toMatchObject({ kind: 'scanner' });
    fixture.app = createApp({
      stores: { sessions: createSessionStore(env, clock), apiKeys: keys, scanners },
      clock,
    });
    for (const headers of [key.headers, terminal.headers, device.headers]) {
      const response = await preview(own, headers);
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toContain('no-store');
    }
  });

  it('permits tenant roles with pass read and template or scanning read', async () => {
    const { org, own, memberSession, preview, previewAudits } = fixture;
    for (const role of ['org_admin', 'pass_operator', 'read_only'] as const) {
      const session = await memberSession([role]);
      const response = await preview(own, session.headers);
      expect(response.status, role).toBe(200);
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(await response.json()).toHaveProperty('scope');
      expect(await previewAudits(session.userId)).toEqual([
        { org_id: org.id, target_id: own.passId },
      ]);
    }
  });

  it('denies either missing read capability even to a platform administrator', async () => {
    const { org, own, memberSession, preview, previewAudits } = fixture;
    for (const role of [
      'integration_admin',
      'template_author',
      'template_reviewer',
      'template_publisher',
    ] as const) {
      const session = await memberSession([role], org.id, true);
      const response = await preview(own, session.headers);
      expect(response.status, role).toBe(403);
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(await previewAudits(session.userId)).toEqual([]);
    }
  });

  it('rejects roles above the tenant scan role and permits equal or lower roles', async () => {
    const { org, own, memberSession, preview, previewAudits } = fixture;
    for (const [role, platformAdmin, seesDesk, seesManager] of [
      ['org_admin', false, true, true],
      ['pass_operator', false, true, false],
      ['pass_operator', true, true, false],
      ['read_only', false, false, false],
      ['read_only', true, false, false],
    ] as const) {
      const session = await memberSession([role], org.id, platformAdmin);
      const manager = await preview(own, session.headers, { role: 'manager' });
      expect(manager.status, role).toBe(seesManager ? 200 : 403);
      if (seesManager) {
        const body = (await manager.json()) as { scope: { inputs: Record<string, unknown> } };
        expect(body.scope.inputs).toHaveProperty('managerNote', 'manager-only');
        expect(body.scope.inputs).toHaveProperty('deskNote', 'desk-only');
      } else {
        expect(await manager.text()).not.toContain('manager-only');
        expect(await previewAudits(session.userId)).toEqual([]);
      }
      const desk = await preview(own, session.headers, { role: 'desk' });
      expect(desk.status, role).toBe(seesDesk ? 200 : 403);
      if (seesDesk) {
        const body = (await desk.json()) as { scope: { inputs: Record<string, unknown> } };
        expect(body.scope.inputs).toHaveProperty('deskNote', 'desk-only');
        expect(body.scope.inputs).not.toHaveProperty('managerNote');
      } else {
        expect(await desk.text()).not.toContain('desk-only');
      }
      const door = await preview(own, session.headers);
      expect(door.status, role).toBe(200);
      const body = (await door.json()) as { scope: { inputs: Record<string, unknown> } };
      expect(body.scope.inputs).toHaveProperty('memberName', 'Alex Morgan');
      expect(body.scope.inputs).not.toHaveProperty('deskNote');
      expect(body.scope.inputs).not.toHaveProperty('managerNote');
    }
  });

  it('masks foreign resources and honors the explicitly selected org even for a multi-org member', async () => {
    const { f, org, otherOrg, own, foreign, memberSession, preview, problem, previewAudits } =
      fixture;
    const session = await memberSession(['pass_operator']);
    const unknown = await preview({ ...own, passId: f.ids.id() }, session.headers);
    const forgedOrg = await preview({ ...foreign, orgId: org.id }, session.headers);
    const foreignOrg = await preview(foreign, session.headers);
    expect(unknown.status).toBe(404);
    expect(forgedOrg.status).toBe(404);
    expect(foreignOrg.status).toBe(404);
    const expected = await problem(unknown);
    expect(await problem(forgedOrg)).toEqual(expected);
    expect(await problem(foreignOrg)).toEqual(expected);
    expect(await previewAudits(session.userId)).toEqual([]);

    await grantScanMembership(f, otherOrg.id, session.userId, ['pass_operator']);
    const wrongSelection = await preview({ ...own, orgId: otherOrg.id }, session.headers);
    expect(wrongSelection.status).toBe(404);
    expect(await problem(wrongSelection)).toEqual(expected);
    expect((await preview(own, session.headers)).status).toBe(200);
    expect((await preview(foreign, session.headers)).status).toBe(200);
    expect(await previewAudits(session.userId)).toEqual([
      { org_id: org.id, target_id: own.passId },
      { org_id: otherOrg.id, target_id: foreign.passId },
    ]);
  });
});
