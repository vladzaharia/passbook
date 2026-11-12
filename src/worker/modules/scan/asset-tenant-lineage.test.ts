import { beforeAll, describe, expect, it } from 'vitest';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { adminActor, captureScanTenantAuthority, tenantScanRole } from './actor.ts';
import { assetGrantValid, mintAssetGrant } from './assets.ts';
import { candidateById } from './repo-lookup.ts';
import { grantScanMembership, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let template: string;
beforeAll(async () => {
  kit = await setupScanKit();
  await ensureCredentialRefKeyset(kit.env.DB, kit.env);
  template = await kit.scanTemplate('Tenant asset authority', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
});

describe('tenant scanner asset grants', () => {
  it('binds the exact original session roles and authentication method', async () => {
    const user = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, kit.org.id, user.id);
    const session = await makeSession(kit.fx, { userId: user.id, roles: ['admin', 'user'] });
    const auth = await createSessionStore(kit.env, kit.clock).resolve(session.cookieValue);
    if (!auth) throw new Error('Session fixture missing');
    const authority = await tenantAuthorityOf(kit.ctx, auth, kit.org.id, 'scanning:read');
    if (authority.kind !== 'session') throw new Error('Session authority fixture missing');
    const actor = adminActor(auth, 'live', {
      orgId: kit.org.id,
      event: null,
      templateIds: [],
      timeZone: 'UTC',
    });
    actor.platformSessionId = auth.sessionId;
    const capturedAuthority = await captureScanTenantAuthority(kit.ctx, auth, authority);
    actor.tenantAuthority = capturedAuthority;
    actor.role = tenantScanRole(capturedAuthority);
    const pass = await kit.scanPass(template);
    const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
    if (!candidate) throw new Error('Pass fixture missing');
    const grant = await mintAssetGrant(
      kit.ctx,
      actor,
      candidate,
      candidate.connectionGeneration,
      candidate.activeTemplateVersion,
      undefined,
      false,
      'commit',
    );
    expect(
      await assetGrantValid(
        kit.ctx,
        actor,
        candidate,
        candidate.connectionGeneration,
        grant,
        undefined,
        'commit',
        false,
      ),
    ).toBe(true);
    const differentOrder = {
      ...actor,
      tenantAuthority: {
        ...capturedAuthority,
        sessionRoles: ['user', 'admin'] as ('user' | 'admin')[],
      },
    };
    const differentAmr = {
      ...actor,
      tenantAuthority: { ...capturedAuthority, amr: 'magic_link' as const },
    };
    const noRoles = { ...actor, tenantAuthority: { ...capturedAuthority, sessionRoles: [] } };
    expect(
      await assetGrantValid(
        kit.ctx,
        differentOrder,
        candidate,
        candidate.connectionGeneration,
        grant,
        undefined,
        'commit',
        false,
      ),
    ).toBe(false);
    expect(
      await assetGrantValid(
        kit.ctx,
        differentAmr,
        candidate,
        candidate.connectionGeneration,
        grant,
        undefined,
        'commit',
        false,
      ),
    ).toBe(false);
    expect(
      await assetGrantValid(
        kit.ctx,
        noRoles,
        candidate,
        candidate.connectionGeneration,
        grant,
        undefined,
        'commit',
        false,
      ),
    ).toBe(false);
  });
});
