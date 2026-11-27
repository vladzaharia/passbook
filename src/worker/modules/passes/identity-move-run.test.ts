import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { deviceToken, makeApiKey } from '../../../../test/helpers/index.ts';
import {
  createFixtureIdentity,
  FIXTURE_IDENTITY,
} from '../../../passkit/testing/fixture-identity.ts';
import type { OperationDto } from '../../../shared/contracts/operations.ts';
import { createApp } from '../../app.ts';
import { run } from '../../platform/db.ts';
import { registerDevice } from '../apple/service.ts';
import type { BroadcastKit } from '../broadcasts/test-kit.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { handleOperationRun } from '../operations/jobs.ts';
import { keyHeaders } from '../operations/operations-test-fixtures.ts';
import { kindOf } from '../operations/registry.ts';
import { issueReplacement, tellOldPass } from './identity-move.ts';
import { SECOND_ID } from './identity-move-resolver-test-fixtures.ts';
import { runIdentityMove } from './identity-move-run.ts';
import { previewIdentityMove, startIdentityMove } from './identity-move-start.ts';
import {
  ADMIN,
  count,
  DAY,
  moveKit,
  moveOf,
  opRow,
  orgWithPasses,
  passOf,
  replacement,
  runMove,
  startAndRun,
  startMove,
} from './identity-move-test-fixtures.ts';
import { movesOf } from './repo-identity-move.ts';
import { updatePass, voidPass } from './service.ts';
import { setupTenantTestAuth, type TenantTestAuth } from './tenant-test-fixtures.ts';

vi.mock('../identities/resolver.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../identities/resolver.ts')>();
  const { wrapResolver } = await import('./identity-move-resolver-test-fixtures.ts');
  return {
    ...original,
    createIdentityResolver: (...a: Parameters<typeof original.createIdentityResolver>) =>
      wrapResolver(original.createIdentityResolver(...a)),
  };
});

const ORIGIN = 'https://wallet.test';
let kit: BroadcastKit;
let auth: TenantTestAuth;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  kit = await moveKit();
  auth = await setupTenantTestAuth(kit);
  app = createApp({ stores: auth.stores, clock: kit.clock });
});
afterEach(() => {
  kit.mailer.fail = null;
});

const job = () => jobCtxOf(kit);
const onSecond = (orgId: string) =>
  count(
    kit,
    'SELECT count(*) AS n FROM passes WHERE org_id = ? AND identity_id = ?',
    orgId,
    SECOND_ID,
  );
const platformKeyHeaders = async () => {
  const key = await makeApiKey(kit.fx, {
    orgId: null,
    kind: 'platform',
    scopes: ['platform:identities'],
    expiresAt: kit.clock.now() + 30 * DAY,
    ipAllow: ['198.51.100.0/24'],
  });
  return { ...key.headers, 'cf-connecting-ip': '198.51.100.7' };
};
const post = (path: string, headers: Record<string, string>) =>
  app.request(`${ORIGIN}/api/v1/operations${path}`, { method: 'POST', headers }, kit.env);

describe('starting a move', () => {
  it('counts what it would touch and writes nothing', async () => {
    const { org } = await orgWithPasses(kit, 3);
    const preview = await previewIdentityMove(job(), {
      orgId: org.id,
      fromIdentityId: 'platform',
      toIdentityId: SECOND_ID,
    });
    expect(preview).toMatchObject({
      passes: 3,
      registered: 0,
      holders: 3,
      toIdentityId: SECOND_ID,
    });
    expect(await count(kit, 'SELECT count(*) AS n FROM pass_moves WHERE org_id = ?', org.id)).toBe(
      0,
    );
  });

  it('previews against a root whose key cannot be decrypted; starting still refuses', async () => {
    const { org } = await orgWithPasses(kit, 2);
    // A root whose certificate chains to the intermediate this run is given, so only its key is bad.
    const root = await createFixtureIdentity(
      { ...FIXTURE_IDENTITY, passTypeIdentifier: 'pass.mobile.passbook' },
      { now: new Date('2026-01-01T00:00:00.000Z'), days: 3650, caDays: 3650 },
    );
    const base = job();
    const ctx = { ...base, env: { ...base.env, SIGNER_PLATFORM_INTERMEDIATE: root.intermediate } };
    await run(
      kit.env.DB,
      "INSERT OR IGNORE INTO credentials (id, kind, kek_version, iv, wrapped_dek, ciphertext, created_at) VALUES ('cred-bad', 'pass_signer', 1, x'00', x'00', x'00', 1)",
    );
    await run(
      kit.env.DB,
      `INSERT INTO signing_identities
         (id, org_id, label, pass_type_identifier, team_identifier, source, credential_id, cert_pem, not_after,
          provenance, purpose, apns_health, is_default, issuing, created_at)
       VALUES ('slot-bad', NULL, 'Root', ?, ?, 'db', 'cred-bad', ?, ?,
         'platform', 'passes', 'healthy', 0, 1, 1)`,
      [
        'pass.mobile.passbook',
        FIXTURE_IDENTITY.teamIdentifier,
        root.certificate,
        kit.clock.now() + 90 * DAY,
      ],
    );
    const input = { orgId: org.id, fromIdentityId: 'platform', toIdentityId: 'slot-bad' };
    expect(await previewIdentityMove(ctx, input)).toMatchObject({
      passes: 2,
      toIdentityId: 'slot-bad',
    });
    await expect(startIdentityMove(ctx, ADMIN, input)).rejects.toMatchObject({
      code: 'IDENTITY_KEY_UNREADABLE',
    });
    await run(kit.env.DB, "UPDATE signing_identities SET issuing = 0 WHERE id = 'slot-bad'");
    await expect(previewIdentityMove(ctx, input)).rejects.toMatchObject({
      code: 'IDENTITY_RETIRED',
    });
  });

  it('refuses a move to the identity the passes are on, and an unknown org', async () => {
    const { org } = await orgWithPasses(kit, 1);
    await expect(
      startIdentityMove(job(), ADMIN, {
        orgId: org.id,
        fromIdentityId: SECOND_ID,
        toIdentityId: SECOND_ID,
      }),
    ).rejects.toMatchObject({ code: 'IDENTITY_MOVE_SAME' });
    await expect(
      startIdentityMove(job(), ADMIN, {
        orgId: 'nope',
        fromIdentityId: 'platform',
        toIdentityId: SECOND_ID,
      }),
    ).rejects.toMatchObject({ code: 'ORG_NOT_FOUND' });
  });

  it('has one active move per org, and a repeat of the same start answers the same operation', async () => {
    const { org } = await orgWithPasses(kit, 1);
    const input = { orgId: org.id, fromIdentityId: 'platform', toIdentityId: SECOND_ID };
    const first = await startIdentityMove(job(), ADMIN, { ...input, id: 'a'.repeat(32) });
    const again = await startIdentityMove(job(), ADMIN, { ...input, id: 'a'.repeat(32) });
    expect(again.id).toBe(first.id);
    await expect(startIdentityMove(job(), ADMIN, input)).rejects.toMatchObject({
      code: 'OPERATION_RUNNING',
    });
    // The refused start left no settings behind.
    expect(
      await count(kit, 'SELECT count(*) AS n FROM identity_moves WHERE org_id = ?', org.id),
    ).toBe(1);
    expect(
      await count(
        kit,
        "SELECT count(*) AS n FROM audit_log WHERE action = 'identity.move_started' AND org_id = ?",
        org.id,
      ),
    ).toBe(1);
  });

  it('is a platform kind that a person must be stepped up for, and an admin alone may stop or retry', () => {
    expect(kindOf('identity.move')).toMatchObject({
      audience: 'platform',
      stepUp: true,
      retry: true,
      cancel: 'between-steps',
    });
  });
});

describe('a re-run after a partial run', () => {
  it('hands the rest to a follow-up job when its time is up, and finishes in the next', async () => {
    const { org } = await orgWithPasses(kit, 3);
    const op = await startIdentityMove(job(), ADMIN, {
      orgId: org.id,
      fromIdentityId: 'platform',
      toIdentityId: SECOND_ID,
    });
    await runIdentityMove(job(), op, 'lease-1', { budgetMs: -1 });
    expect(await onSecond(org.id)).toBe(0);
    expect((await opRow(kit, op.id)).status).not.toBe('succeeded');
    expect(
      kit.queue.sent.filter((m) => (m as { operationId?: string }).operationId === op.id).length,
    ).toBeGreaterThan(1);
    await runIdentityMove(job(), op, 'lease-1');
    expect(await onSecond(org.id)).toBe(3);
    expect((await opRow(kit, op.id)).status).toBe('succeeded');
  });

  it('makes no second pass and no second email for a row that crashed after its pass was made', async () => {
    const { org, passes } = await orgWithPasses(kit, 2);
    const first = await startAndRun(kit, org.id);
    expect((await opRow(kit, first.id)).status).toBe('succeeded');
    const crashed = await moveOf(kit, (passes[0] as { id: string }).id);
    // The pass and its mail were made; the row never learned.
    await run(
      kit.env.DB,
      `UPDATE pass_moves SET state = 'planned', copied_hash = NULL, emailed_at = NULL, told_at = NULL WHERE id = ?`,
      [crashed.id],
    );
    await startAndRun(kit, org.id);
    expect(await onSecond(org.id)).toBe(2);
    expect(
      await count(
        kit,
        "SELECT count(*) AS n FROM outbox WHERE kind = 'email' AND pass_id = ?",
        crashed.new_pass_id,
      ),
    ).toBe(1);
    expect((await moveOf(kit, (passes[0] as { id: string }).id)).state).toBe('notified');
  });

  it('plans the same passes again without a second row', async () => {
    const { org } = await orgWithPasses(kit, 2);
    await startAndRun(kit, org.id);
    await startAndRun(kit, org.id);
    expect(await count(kit, 'SELECT count(*) AS n FROM pass_moves WHERE org_id = ?', org.id)).toBe(
      2,
    );
    expect(await onSecond(org.id)).toBe(2);
  });

  it('retries the passes that failed and finishes the move', async () => {
    const { org } = await orgWithPasses(kit, 2);
    const op = await startMove(kit, org.id);
    await run(kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [org.id]);
    await runMove(kit, op);
    const failed = await opRow(kit, op.id);
    expect([failed.status, failed.error_code, failed.error_retryable]).toEqual([
      'failed',
      'IDENTITY_MOVE_PARTIAL',
      1,
    ]);
    expect(await onSecond(org.id)).toBe(0);
    await run(kit.env.DB, "UPDATE orgs SET status = 'active' WHERE id = ?", [org.id]);
    const retried = await post(`/${op.id}/retry`, auth.admin());
    expect(retried.status).toBe(200);
    const next = (await retried.json()) as OperationDto;
    await handleOperationRun(
      { kind: 'operation.run', operationId: op.id, attempt: next.attempt },
      job(),
    );
    expect((await opRow(kit, op.id)).status).toBe('succeeded');
    expect(await onSecond(org.id)).toBe(2);
  });
});

describe('a pass already moved, or not eligible', () => {
  it('is not moved twice, and another org on the same identity is left alone', async () => {
    const { org } = await orgWithPasses(kit, 2);
    const other = await orgWithPasses(kit, 1);
    await startAndRun(kit, org.id);
    const before = await onSecond(org.id);
    await startAndRun(kit, org.id);
    expect(await onSecond(org.id)).toBe(before);
    expect(await onSecond(other.org.id)).toBe(0);
    expect((await passOf(kit, (other.passes[0] as { id: string }).id)).identityId).toBe('platform');
  });

  it('skips voided passes, and keeps a pass voided between the plan and the issue', async () => {
    const { org, passes } = await orgWithPasses(kit, 3);
    const [a, b, c] = passes as unknown as [{ id: string }, { id: string }, { id: string }];
    await voidPass(job(), { type: 'user', id: 'admin-1' }, a.id, org.id);
    const op = await startIdentityMove(job(), ADMIN, {
      orgId: org.id,
      fromIdentityId: 'platform',
      toIdentityId: SECOND_ID,
    });
    await runIdentityMove(job(), op, 'l', { budgetMs: -1 });
    await voidPass(job(), { type: 'user', id: 'admin-1' }, b.id, org.id);
    await runIdentityMove(job(), op, 'l');
    expect(
      await count(kit, 'SELECT count(*) AS n FROM pass_moves WHERE old_pass_id = ?', a.id),
    ).toBe(0);
    expect(await moveOf(kit, b.id)).toMatchObject({ state: 'kept', reason: 'old_gone' });
    expect((await moveOf(kit, c.id)).state).toBe('notified');
    expect(await onSecond(org.id)).toBe(1);
  });
});

describe('a pass edited mid-move', () => {
  it('keeps the edit through the tell, and the replacement is the pass as it was copied', async () => {
    const { org, passes } = await orgWithPasses(kit, 1);
    const old = passes[0] as { id: string };
    const op = await startIdentityMove(job(), ADMIN, {
      orgId: org.id,
      fromIdentityId: 'platform',
      toIdentityId: SECOND_ID,
    });
    await runIdentityMove(job(), op, 'l', { budgetMs: -1 });
    const [row] = await movesOf(kit.env.DB, { opId: op.id, state: 'planned', after: '', limit: 5 });
    if (!row) throw new Error('no row');
    await issueReplacement(job(), row);
    await updatePass(
      job(),
      { type: 'user', id: 'admin-1' },
      old.id,
      { input: { memberName: 'Edited' } },
      { scope: org.id },
    );
    await tellOldPass(job(), { ...row, state: 'issued' });
    const told = await passOf(kit, old.id);
    expect(told.personalization.memberName).toBe('Edited');
    expect(String(told.personalization.message)).toContain('/p/');
    expect((await passOf(kit, row.new_pass_id)).personalization.memberName).toBe('Alex');
    // The sweep's carry gives the edit to the replacement before the old pass voids (identity-move.test.ts).
  });
});

describe('cancelling', () => {
  it('stops new replacements and leaves the ones already issued working', async () => {
    const { org, passes } = await orgWithPasses(kit, 3);
    const op = await startIdentityMove(job(), ADMIN, {
      orgId: org.id,
      fromIdentityId: 'platform',
      toIdentityId: SECOND_ID,
    });
    await runIdentityMove(job(), op, 'l', { budgetMs: -1 });
    const [row] = await movesOf(kit.env.DB, { opId: op.id, state: 'planned', after: '', limit: 1 });
    if (!row) throw new Error('no row');
    await issueReplacement(job(), row);
    await run(kit.env.DB, 'UPDATE operations SET cancel_requested = 1 WHERE id = ?', [op.id]);
    await handleOperationRun({ kind: 'operation.run', operationId: op.id, attempt: 1 }, job());
    expect((await opRow(kit, op.id)).status).toBe('cancelled');
    expect(await onSecond(org.id)).toBe(1);
    const kept = await passOf(kit, row.old_pass_id);
    expect(kept.status).toBe('active');
    expect(passes).toHaveLength(3);
  });
});

describe('who may stop or retry it', () => {
  it('lets an admin session stop a queued move and refuses every token and non-admin', async () => {
    const { org } = await orgWithPasses(kit, 1);
    const op = await startIdentityMove(job(), ADMIN, {
      orgId: org.id,
      fromIdentityId: 'platform',
      toIdentityId: SECOND_ID,
    });
    const keys = [
      await keyHeaders(kit, ['passes:operate']),
      await platformKeyHeaders(),
      await auth.apiKey({ scopes: ['passes:write'] }),
    ];
    for (const headers of [...keys, auth.user()]) {
      for (const verb of ['cancel', 'retry'])
        expect((await post(`/${op.id}/${verb}`, headers)).status, verb).toBeGreaterThanOrEqual(400);
    }
    expect((await opRow(kit, op.id)).status).toBe('queued');
    expect((await post(`/${op.id}/cancel`, auth.admin())).status).toBe(200);
    expect((await opRow(kit, op.id)).status).toBe('cancelled');
  });

  it('refuses a token a retry of a failed move', async () => {
    const { org } = await orgWithPasses(kit, 1);
    const op = await startMove(kit, org.id);
    await run(kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [org.id]);
    await runMove(kit, op);
    expect((await opRow(kit, op.id)).status).toBe('failed');
    for (const headers of [await keyHeaders(kit, ['passes:operate']), await platformKeyHeaders()])
      expect((await post(`/${op.id}/retry`, headers)).status).toBeGreaterThanOrEqual(400);
    expect((await opRow(kit, op.id)).attempt).toBe(1);
    await run(kit.env.DB, "UPDATE orgs SET status = 'active' WHERE id = ?", [org.id]);
  });
});

describe('the Wallet register hook', () => {
  it('starts the old pass timer when the replacement registers through the web service', async () => {
    const { passes } = await orgWithPasses(kit, 1);
    const old = passes[0] as { id: string };
    const { org } = { org: { id: (await passOf(kit, old.id)).orgId } };
    await startAndRun(kit, org.id);
    const next = await replacement(kit, await passOf(kit, old.id));
    expect((await moveOf(kit, old.id)).state).toBe('notified');
    // The same device holds the old pass: its add of the replacement is the one that arms the timer.
    await kit.device(await passOf(kit, old.id), 'a'.repeat(32), 'c'.repeat(64));
    await registerDevice(job(), {
      deviceId: 'a'.repeat(32),
      passTypeId: 'pass.test.second',
      serial: next.serial,
      authorization: `ApplePass ${deviceToken(next)}`,
      pushToken: 'b'.repeat(64),
    });
    const armed = await moveOf(kit, old.id);
    expect(armed.state).toBe('registered');
    expect(armed.void_at).toBe((armed.registered_at as number) + DAY);
  });
});
