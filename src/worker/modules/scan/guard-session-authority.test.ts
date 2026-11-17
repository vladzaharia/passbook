import type { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeOrg, makeScanner, makeTemplate, makeUser } from '../../../../test/helpers/index.ts';
import type { AppBindings } from '../../platform/context.ts';
import { run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { AppError } from '../../platform/errors.ts';
import { type ScanActor, scanScannerCsrfProof } from './actor.ts';
import { createGuardHarness, get, ORIGIN } from './guard-test-fixtures.ts';
import { scanAuthorizedStmt, scanReadAuthority } from './repo-read-authority.ts';
import { grantScanMembership } from './test-kit.ts';

const harness = createGuardHarness();
let { f, clock, fake, orgId } = harness;
const { persistApprovedTemplate } = harness;
const build: typeof harness.build = async (...args) => {
  const result = await harness.build(...args);
  ({ f, clock, fake, orgId } = harness);
  return result;
};

describe('requireScanActor: tenant session authority', () => {
  let app: Hono<AppBindings>;
  let env: AppEnv;
  beforeEach(async () => {
    ({ app, env } = await build());
  });

  const scope = () => `?orgId=${orgId}&timeZone=UTC`;
  const captured = (): ScanActor => {
    const actor = harness.capturedActor;
    if (!actor) throw new Error('No scan actor captured');
    return actor;
  };
  const current = async (actor: ScanActor) => {
    try {
      return (
        (
          await scanAuthorizedStmt(env.DB, scanReadAuthority(actor, { now: clock.now() })).first<{
            authorized: number;
          }>()
        )?.authorized === 1
      );
    } catch (error) {
      // An actor the guard did not capture has no authority to read.
      if (error instanceof AppError && error.code === 'SCAN_EPOCHS_MISSING') return false;
      throw error;
    }
  };

  it('requires membership even for a platform administrator and another tenant', async () => {
    const outsider = fake.session({ userId: 'outsider', roles: ['admin', 'user'] });
    await expectProblem(await get(app, env, `/capture-read${scope()}`, outsider), 403, 'FORBIDDEN');
    const other = await makeOrg(f);
    expect(
      (await get(app, env, `/capture-manage?orgId=${other.id}&timeZone=UTC`, fake.admin())).status,
    ).toBe(403);
  });

  it('permits a tenant reader on explicitly read-only GET and POST, but not the safe default', async () => {
    const user = await makeUser(f);
    const membershipId = await grantScanMembership(f, orgId, user.id, ['read_only']);
    const headers = fake.user(user.id);
    expect((await get(app, env, `/capture-read${scope()}`, headers)).status).toBe(200);
    const actor = captured();
    expect(actor.role).toBe('door');
    expect(actor.tenantAuthority).toMatchObject({
      kind: 'session',
      orgId,
      userId: user.id,
      membershipId,
      capability: 'scanning:read',
    });
    expect(await current(actor)).toBe(true);
    const readPost = await app.request(
      `${ORIGIN}/capture-read`,
      {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ scope: { orgId, timeZone: 'UTC' } }),
      },
      env,
    );
    expect(readPost.status).toBe(200);
    await expectProblem(
      await get(app, env, `/capture-operate${scope()}`, headers),
      403,
      'FORBIDDEN',
    );
    await expectProblem(
      await get(app, env, `/capture-manage${scope()}`, headers),
      403,
      'FORBIDDEN',
    );
  });

  it('keeps a session CSRF secret fixed for the life of the session', async () => {
    const user = await makeUser(f);
    await grantScanMembership(f, orgId, user.id, ['read_only']);
    expect((await get(app, env, `/capture-read${scope()}`, fake.user(user.id))).status).toBe(200);
    const authority = captured().tenantAuthority;
    if (!authority) throw new Error('Missing tenant authority');
    await expect(
      run(env.DB, 'UPDATE sessions SET csrf_secret=? WHERE id_hash=?', [
        'rotated',
        authority.sessionId,
      ]),
    ).rejects.toThrow(/session csrf secret is immutable/);
  });

  it('captures scanner proofs and refuses a rotated scanner secret', async () => {
    const scanner = await makeScanner(f, { orgId });
    expect((await get(app, env, '/capture-manage', scanner.headers)).status).toBe(200);
    const actor = captured();
    const secret = scanner.headers['x-csrf-token'];
    if (!secret) throw new Error('Missing scanner CSRF secret');
    expect(actor.scanner?.csrfSecret).toBeNull();
    expect(actor.scannerCsrfProof).toBe(await scanScannerCsrfProof(env, scanner.id, secret));
    expect(await current(actor)).toBe(true);
    await expect(
      run(env.DB, 'UPDATE scanners SET csrf_secret=? WHERE id=?', ['rotated', scanner.id]),
    ).rejects.toThrow(/scanner credential revision must advance/);
    await run(env.DB, 'UPDATE scanners SET csrf_secret=?,updated_at=updated_at+1 WHERE id=?', [
      'rotated',
      scanner.id,
    ]);
    // A rotated secret moves the credential epoch the actor was captured with.
    expect(await current(actor)).toBe(false);
    const terminal = await makeScanner(f, { orgId, kind: 'terminal' });
    expect((await get(app, env, '/capture-manage', terminal.headers)).status).toBe(200);
    expect(captured().scannerCsrfProof).toBeNull();
    expect(await current(captured())).toBe(true);
  });

  it('derives scanner roles from tenant capabilities, not platform roles', async () => {
    const operator = await makeUser(f);
    await grantScanMembership(f, orgId, operator.id, ['read_only', 'pass_operator']);
    expect((await get(app, env, `/capture-read${scope()}`, fake.user(operator.id))).status).toBe(
      200,
    );
    expect(captured().role).toBe('desk');
    expect(await current(captured())).toBe(true);

    const passOperator = await makeUser(f);
    await grantScanMembership(f, orgId, passOperator.id, ['pass_operator']);
    expect(
      (await get(app, env, `/capture-read${scope()}`, fake.user(passOperator.id))).status,
    ).toBe(200);
    expect(
      (await get(app, env, `/capture-operate${scope()}`, fake.user(passOperator.id))).status,
    ).toBe(200);
    expect(captured().role).toBe('desk');
    expect(captured().tenantAuthority?.capability).toBe('passes:operate');
    expect(await current(captured())).toBe(true);
    const noScanning = await makeUser(f);
    await grantScanMembership(f, orgId, noScanning.id, ['template_author']);
    expect((await get(app, env, `/capture-read${scope()}`, fake.user(noScanning.id))).status).toBe(
      403,
    );
    expect((await get(app, env, `/capture-read${scope()}`, fake.admin())).status).toBe(200);
    expect(captured().role).toBe('manager');
  });

  it('fails closed when a session snapshot is missing or does not match the actor', async () => {
    expect((await get(app, env, `/capture-manage${scope()}`, fake.admin())).status).toBe(200);
    const actor = captured();
    expect(actor.tenantAuthority?.capability).toBe('scanning:manage');
    expect(await current(actor)).toBe(true);
    expect(await current({ ...actor, role: 'door' })).toBe(true);
    expect(await current({ ...actor, tenantAuthority: undefined })).toBe(false);
    const nullAuthority = { ...actor };
    Object.defineProperty(nullAuthority, 'tenantAuthority', { value: null });
    expect(await current(nullAuthority)).toBe(false);
    expect(await current({ ...actor, orgId: 'another-org' })).toBe(false);
    expect(await current({ ...actor, actor: { type: 'user', id: 'another-user' } })).toBe(false);
  });

  it('invalidates snapshots through role removal, regrant, and same-role ABA', async () => {
    const user = await makeUser(f);
    const originalId = await grantScanMembership(f, orgId, user.id);
    const headers = fake.user(user.id);
    expect((await get(app, env, `/capture-manage${scope()}`, headers)).status).toBe(200);
    const original = captured();
    expect(await current(original)).toBe(true);

    await run(env.DB, 'UPDATE org_memberships SET revoked_at=? WHERE id=?', [
      clock.now(),
      originalId,
    ]);
    expect(await current(original)).toBe(false);
    const readerId = await grantScanMembership(f, orgId, user.id, ['read_only']);
    expect(await current(original)).toBe(false);
    await expectProblem(
      await get(app, env, `/capture-manage${scope()}`, headers),
      403,
      'FORBIDDEN',
    );
    expect((await get(app, env, `/capture-read${scope()}`, headers)).status).toBe(200);
    const reader = captured();
    expect(await current(reader)).toBe(true);

    await run(env.DB, 'UPDATE org_memberships SET revoked_at=? WHERE id=?', [
      clock.now(),
      readerId,
    ]);
    const restoredId = await grantScanMembership(f, orgId, user.id);
    expect(restoredId).not.toBe(originalId);
    expect(await current(original)).toBe(false);
    expect(await current(reader)).toBe(false);
    expect((await get(app, env, `/capture-manage${scope()}`, headers)).status).toBe(200);
    expect(await current(captured())).toBe(true);
  });

  it('keeps the scanner token boundary while denying unassigned template access', async () => {
    const template = makeTemplate({ id: f.ids.id(), orgId });
    await persistApprovedTemplate(template);
    const empty = await makeScanner(f, { orgId, settings: { acceptAllTemplates: false } });
    const assigned = await makeScanner(f, {
      orgId,
      templateIds: [template.resolved.id],
      settings: { acceptAllTemplates: false },
    });
    const path = `/authority?templateId=${template.resolved.id}`;
    expect(await (await get(app, env, path, empty.headers)).json()).toEqual({ current: false });
    expect(await (await get(app, env, path, assigned.headers)).json()).toEqual({ current: true });
  });
});
