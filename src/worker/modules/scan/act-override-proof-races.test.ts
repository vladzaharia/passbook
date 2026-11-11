import { beforeAll, describe, expect, it } from 'vitest';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import { makeScanner } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getHolderPass } from '../holders/repo.ts';
import { startCredentialTransfer } from '../passes/credential-transfer.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { claimRemoval, getPassLifecycle, releaseRemoval } from '../passes/repo-remove.ts';
import { setupSamsungCallbacks } from '../wallet-providers/callbacks-test-fixtures.ts';
import { act as actService } from './act.ts';
import { scannerActor, withRole } from './actor.ts';
import {
  atGate,
  type CapturedState,
  expectInvalid,
  kit,
  request,
  scenario,
  setupOverrideProof,
  state,
} from './repo-act-override-proof-test-fixtures.ts';
import { getScanner } from './repo-device.ts';
import { readScannerScope } from './repo-scope.ts';
import { key, proofedScanActor, startScanCredentialTransfer } from './test-kit.ts';

beforeAll(setupOverrideProof);
const providerEnv = installKeysetTestEnv();

describe('override event provenance', () => {
  it.each(['role', 'policy'] as const)(
    'does not override when the current scanner %s changes before the gate batch',
    async (field) => {
      const s = await scenario();
      const before = await state(s.pass.id);
      const idempotencyKey = key();
      const response = await atGate(
        async (db) => {
          await run(
            db,
            field === 'role'
              ? "UPDATE scanners SET settings=json_set(settings,'$.roleWithoutSignIn','desk'),updated_at=updated_at+1 WHERE id=?"
              : "UPDATE scanners SET settings=json_set(settings,'$.letInAgain','never'),updated_at=updated_at+1 WHERE id=?",
            [s.scanner.id],
          );
        },
        () => request(s.scanner, s.input, { overrideOf: s.headsId, idempotencyKey }),
      );
      // Scanner settings are config: a classified 409, claim released unfinished, nothing written.
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'SCAN_CONFIG_CHANGED' });
      expect(await state(s.pass.id)).toEqual(before);
      expect(
        await first(kit.env.DB, 'SELECT state,outcome FROM scans WHERE idempotency_key=?', [
          idempotencyKey,
        ]),
      ).toEqual({ state: 'failed', outcome: null });
      // The released key retries under the new settings: a desk role still overrides, a policy of
      // 'never' does not.
      const retry = await request(s.scanner, s.input, { overrideOf: s.headsId, idempotencyKey });
      if (field === 'policy') {
        expect(retry.status === 200 ? (await retry.json()).kind : retry.status).not.toBe('ok');
        expect(await state(s.pass.id)).toEqual(before);
      }
    },
  );

  it('does not commit when the manager approval is revoked before the gate batch', async () => {
    const manager = await kit.staff('manager');
    const s = await scenario({ letInAgain: 'manager' });
    const before = await state(s.pass.id);
    const idempotencyKey = key();
    const options = {
      overrideOf: s.headsId,
      idempotencyKey,
      approval: { staffId: manager.id, pin: manager.pin },
    };
    const response = await atGate(
      async (db) => {
        await run(db, 'UPDATE scan_staff SET disabled_at=? WHERE id=?', [
          kit.clock.now(),
          manager.id,
        ]);
      },
      () => request(s.scanner, s.input, options),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'SCAN_STAFF_CHANGED' });
    expect(await state(s.pass.id)).toEqual(before);
    expect(
      await first(kit.env.DB, 'SELECT state,outcome FROM scans WHERE idempotency_key=?', [
        idempotencyKey,
      ]),
    ).toEqual({ state: 'failed', outcome: null });
    const retry = await request(s.scanner, s.input, options);
    expect(retry.status === 200 ? (await retry.json()).kind : retry.status).not.toBe('ok');
    expect(await state(s.pass.id)).toEqual(before);
  });

  it('rejects an expired heads-up before claiming a gate', async () => {
    const s = await scenario();
    kit.clock.advance(11 * 60_000);
    await expectInvalid(s);
  });

  it('fences a real transfer started after verification, without retrying the stale override', async () => {
    const t = await setupSamsungCallbacks({
      holderEmail: 'previous@example.test',
      db: (await providerEnv()).DB,
    });
    const scanner = await makeScanner(t.kit.fx, {
      orgId: t.kit.org.id,
      templateIds: [t.kit.template.id],
      settings: { letInAgain: 'anyone' },
    });
    const row = await getScanner(t.kit.env.DB, scanner.id);
    if (!row) throw new Error('Missing scanner');
    const scope = await readScannerScope(t.kit.env.DB, row, null);
    const actor = await proofedScanActor(
      t.kit.ctx,
      withRole(scannerActor(t.kit.ctx, row, 'live', 'cookie', scope), null),
    );
    const input = { passId: t.pass.id, method: 'manual' as const };
    const action = (idempotencyKey: string, overrideOf?: string) =>
      actService(t.kit.ctx, actor, {
        idempotencyKey,
        input,
        clientTs: t.kit.clock.now(),
        actionId: 'check_in',
        ...(overrideOf ? { overrideOf } : {}),
      });
    expect((await action(key())).outcome.kind).toBe('ok');
    const heads = (await action(key())).outcome;
    expect(heads).toMatchObject({ kind: 'heads_up', reason: 'already_done', overridable: true });
    if (!heads.scanId) throw new Error('Missing heads-up scan');
    const expected = await getHolderPass(t.kit.env.DB, t.pass.id, null);
    const before = await first<{ credential_generation: number; link_generation: number }>(
      t.kit.env.DB,
      'SELECT credential_generation,link_generation FROM passes WHERE id=?',
      [t.pass.id],
    );
    if (!expected || !before) throw new Error('Missing transfer source');
    const idempotencyKey = key();
    let afterTransfer: CapturedState | undefined;
    await expect(
      atGate(
        async (db) => {
          await startCredentialTransfer(
            jobCtxOf(t.kit),
            { type: 'system', id: null },
            t.pass.id,
            {
              holderEmail: 'next@example.test',
              ownerUserId: null,
            },
            null,
            { kind: 'tenant-holder', expected },
          );
          expect(
            await first(
              db,
              "SELECT state FROM pass_credential_transfers WHERE pass_id=? AND state='pending'",
              [t.pass.id],
            ),
          ).toEqual({ state: 'pending' });
          const current = await first<{ credential_generation: number; link_generation: number }>(
            db,
            'SELECT credential_generation,link_generation FROM passes WHERE id=?',
            [t.pass.id],
          );
          expect(current!.credential_generation).toBeGreaterThan(before.credential_generation);
          expect(current!.link_generation).toBeGreaterThan(before.link_generation);
          afterTransfer = await state(t.pass.id, db);
        },
        () => action(idempotencyKey, heads.scanId!),
        t.kit.env,
      ),
    ).rejects.toThrow('The pass changed');
    if (!afterTransfer) throw new Error('Missing transfer snapshot');
    expect(await state(t.pass.id, t.kit.env.DB)).toEqual(afterTransfer);
    // The transfer is authority: nothing was recorded for the stale override.
    expect(
      await first(
        t.kit.env.DB,
        "SELECT 1 AS n FROM scans WHERE idempotency_key=? AND state='done'",
        [idempotencyKey],
      ),
    ).toBeNull();
    expect(await state(t.pass.id, t.kit.env.DB)).toEqual(afterTransfer);
  });

  // The old family that edited the heads-up's ledger bytes, ref, envelope, id, scan fields or gate
  // count after verification is gone: those facts are plain (no event proof or MAC), and the commit
  // trusts them. Only the pass's own lifecycle and credential are authority.
  it.each(['credential-generation', 'lifecycle-generation', 'lifecycle-aba'] as const)(
    'refuses 409 SCAN_PASS_CHANGED when the pass %s moves after verification',
    async (change) => {
      const s = await scenario();
      const idempotencyKey = key();
      let afterChange: CapturedState | undefined;
      const response = await atGate(
        async (db) => {
          if (change === 'credential-generation')
            expect((await startScanCredentialTransfer(kit, s.pass.id, { db })).state).toBe(
              'completed',
            );
          else if (change === 'lifecycle-generation')
            await run(
              db,
              'UPDATE passes SET lifecycle_generation=lifecycle_generation+1 WHERE id=?',
              [s.pass.id],
            );
          else if (change === 'lifecycle-aba') {
            const before = await first<{
              version: number;
              revision: number;
              lifecycle_generation: number;
              removed_at: number | null;
            }>(
              db,
              'SELECT version,revision,lifecycle_generation,removed_at FROM passes WHERE id=?',
              [s.pass.id],
            );
            if (!before) throw new Error('Missing pass lifecycle');
            const pass = await getPass(db, s.pass.id, null);
            if (!pass) throw new Error('Missing pass');
            const lifecycle = await getPassLifecycle(db, pass);
            if (!lifecycle) throw new Error('Missing lifecycle snapshot');
            const state = { at: kit.clock.now(), message: null, priorStatus: pass.status };
            const generation = await claimRemoval(
              { ...kit.ctx, env: { ...kit.env, DB: db } },
              s.pass.id,
              state,
              {
                pass,
                generation: lifecycle.generation,
                now: kit.clock.now(),
              },
            );
            if (generation === null) throw new Error('Removal claim failed');
            await releaseRemoval(db, s.pass.id, { pass, state, generation });
            const after = await first<{
              version: number;
              revision: number;
              lifecycle_generation: number;
              removed_at: number | null;
            }>(
              db,
              'SELECT version,revision,lifecycle_generation,removed_at FROM passes WHERE id=?',
              [s.pass.id],
            );
            expect(after).toMatchObject({
              version: before.version,
              revision: before.revision,
              removed_at: before.removed_at,
            });
            expect(after!.lifecycle_generation).toBeGreaterThan(before.lifecycle_generation);
          }
          afterChange = await state(s.pass.id);
        },
        () => request(s.scanner, s.input, { overrideOf: s.headsId, idempotencyKey }),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'SCAN_PASS_CHANGED' });
      if (!afterChange) throw new Error('Missing interleaved snapshot');
      expect(await state(s.pass.id)).toEqual(afterChange);
      expect(
        await first(kit.env.DB, 'SELECT state,outcome FROM scans WHERE idempotency_key=?', [
          idempotencyKey,
        ]),
      ).toEqual({ state: 'failed', outcome: null });
    },
  );
});
