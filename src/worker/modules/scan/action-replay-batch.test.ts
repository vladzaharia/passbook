import { describe, expect, it } from 'vitest';
import { stagePendingCredentialTransfer } from '../../../../test/helpers/credential-transfer.ts';
import { countD1 } from '../../../../test/helpers/index.ts';
import { ScanOutcomeSchema } from '../../../shared/contracts/scan.ts';
import { first, run, stmt } from '../../platform/db.ts';
import { clearSettingsCache } from '../settings/service.ts';
import {
  ACTION,
  beforeReceiptCas,
  coldReplay,
  fixture,
} from './action-replay-batch-test-fixtures.ts';
import { credentialTombstoneRefsForInput } from './credential-input.ts';
import { effectCounts } from './repo-action-replay-batch-test-fixtures.ts';
import {
  clearScanRetentionDeleteStmt,
  stageScanRetentionDeleteStmt,
} from './repo-scan-retention.ts';
import { scanSecretSlots } from './repo-secret-binds.ts';
import { prepareScanRetentionDelete } from './scan-retention-proof.ts';
import { key, setupScanKit } from './test-kit.ts';

describe('bounded scanner action replay', () => {
  it('replays cold history and photo policy in at most five post-guard trips without new effects', async () => {
    const { kit, scanner, pass, request, original } = await fixture();
    const before = await effectCounts(kit.env.DB, original.scanId!, pass.id);
    const real = kit.env.DB;
    const counted = countD1(real);
    const binds: { sql: string; values: unknown[] }[] = [];
    const observed = new Proxy(counted.db, {
      get(target, prop) {
        if (prop === 'prepare')
          return (sql: string) =>
            new Proxy(target.prepare(sql), {
              get(statement, member) {
                if (member === 'bind')
                  return (...values: unknown[]) => {
                    binds.push({ sql, values });
                    return statement.bind(...values);
                  };
                const value = Reflect.get(statement, member, statement);
                return typeof value === 'function' ? value.bind(statement) : value;
              },
            });
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    Object.assign(kit.env, { DB: observed });
    try {
      await kit.post(scanner.headers, '/actions', {});
      const guard = counted.count();
      counted.reset();
      binds.length = 0;
      clearSettingsCache(observed);
      const response = await kit.post(scanner.headers, '/actions', request);
      expect(response.status).toBe(200);
      const replay = ScanOutcomeSchema.parse(await response.json());
      expect(replay).toMatchObject({
        kind: 'ok',
        replay: true,
        scanId: original.scanId,
        action: { id: ACTION.id, label: ACTION.label, kind: ACTION.kind },
        card: null,
        display: null,
      });
      expect(counted.count() - guard).toBeLessThanOrEqual(5);
      const secrets = [
        pass.authToken,
        pass.downloadToken,
        pass.scanCode,
        scanner.headers['x-csrf-token'],
      ].filter((value): value is string => typeof value === 'string' && value.length > 0);
      for (const { sql, values } of binds) {
        expect(values.length).toBeLessThanOrEqual(100);
        const slots = scanSecretSlots(sql, values.length);
        for (const [index, value] of values.entries()) {
          if (typeof value !== 'string' || !secrets.some((secret) => value.includes(secret)))
            continue;
          expect(slots?.[index]?.label).toEqual(expect.any(String));
        }
      }
      for (const secret of secrets) expect(JSON.stringify(replay)).not.toContain(secret);
    } finally {
      Object.assign(kit.env, { DB: real });
    }
    expect(await effectCounts(real, original.scanId!, pass.id)).toEqual(before);
  });

  it.each(['wallet', 'ledger', 'csrf'] as const)(
    'checks the original %s again in the final read transaction',
    async (mutation) => {
      const { kit, scanner, pass, request, original } = await fixture();
      const real = kit.env.DB;
      const before = await effectCounts(real, original.scanId!, pass.id);
      const intercepted = beforeReceiptCas(real, 'scan-ephemeral-source-event-json', async () => {
        if (mutation === 'wallet') {
          await run(
            real,
            `UPDATE pass_versions SET pass_json=json_set(pass_json,'$.description','changed after proof')
            WHERE pass_id=? AND version=(SELECT max(version) FROM pass_versions WHERE pass_id=?)`,
            [pass.id, pass.id],
          );
        } else if (mutation === 'ledger') {
          await run(
            real,
            `UPDATE pass_events SET data=json_set(data,'$.authority.passJsonHash',?)
            WHERE pass_id=? AND kind='scan.checked_in'`,
            ['0'.repeat(64), pass.id],
          );
        } else {
          await run(real, 'UPDATE scanners SET csrf_secret=?,updated_at=updated_at+1 WHERE id=?', [
            'replaced-scanner-secret',
            scanner.id,
          ]);
        }
      });
      Object.assign(kit.env, { DB: intercepted.db });
      try {
        const response = await kit.post(scanner.headers, '/actions', request);
        expect(intercepted.fired()).toBe(true);
        if (mutation === 'csrf') {
          // A rotated scanner secret is a credential change: classified, not a masked miss.
          expect(response.status).toBe(401);
          expect(await response.json()).toMatchObject({ code: 'SCANNER_REPAIR' });
          expect(await effectCounts(real, original.scanId!, pass.id)).toEqual(before);
          return;
        }
        expect(response.status).toBe(200);
        const replay = ScanOutcomeSchema.parse(await response.json());
        if (mutation === 'wallet')
          expect(replay).toMatchObject({
            kind: 'ok',
            replay: true,
            scanId: original.scanId,
            action: null,
            card: null,
          });
        else
          expect(replay).toMatchObject({
            kind: 'refused',
            reason: 'not_found',
            replay: false,
            scanId: null,
          });
      } finally {
        Object.assign(kit.env, { DB: real });
      }
      expect(await effectCounts(real, original.scanId!, pass.id)).toEqual(before);
    },
  );
  it('replays a passless miss from its scan row alone', async () => {
    const kit = await setupScanKit();
    const template = await kit.scanTemplate('Passless replay', { actions: [ACTION] });
    const scanner = await kit.scanner({ templateIds: [template] });
    const request = {
      idempotencyKey: key(),
      input: { code: 'NO-MATCH-REPLAY-173', method: 'camera' },
      clientTs: kit.clock.now(),
      actionId: ACTION.id,
    };
    const original = ScanOutcomeSchema.parse(
      await (await kit.post(scanner.headers, '/actions', request)).json(),
    );
    expect(original).toMatchObject({
      kind: 'refused',
      reason: 'not_found',
      replay: false,
      scanId: expect.any(String),
    });
    const control = await coldReplay(kit, scanner.headers, request);
    expect(control.outcome).toMatchObject({
      replay: true,
      scanId: original.scanId,
      reason: 'not_found',
    });
    expect(control.postGuardTrips).toBeLessThanOrEqual(5);
  });

  it('returns a retained receipt but rejects a changed original retention MAC', async () => {
    const { kit, scanner, pass, request, original } = await fixture();
    const real = kit.env.DB;
    const deletion = await prepareScanRetentionDelete(kit.env, pass);
    await real.batch([
      stageScanRetentionDeleteStmt(real, pass.id, deletion),
      stmt(real, 'DELETE FROM passes WHERE id=? RETURNING id', [pass.id]),
      clearScanRetentionDeleteStmt(real, deletion),
    ]);
    const control = await coldReplay(kit, scanner.headers, request);
    expect(control.outcome).toMatchObject({
      kind: 'ok',
      replay: true,
      scanId: original.scanId,
      action: null,
      card: null,
    });
    expect(control.postGuardTrips).toBeLessThanOrEqual(5);
    const trigger = await first<{ sql: string }>(
      real,
      "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='scan_retention_immutable'",
    );
    const proof = await first<{ mac: string }>(
      real,
      'SELECT mac FROM scan_retention_proofs WHERE scan_id=?',
      [original.scanId!],
    );
    if (!trigger || !proof) throw new Error('Missing retention proof or immutability guard');
    await run(real, 'DROP TRIGGER scan_retention_immutable');
    const replacement = proof.mac === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
    const intercepted = beforeReceiptCas(real, 'r.event_digest=', () =>
      run(real, 'UPDATE scan_retention_proofs SET mac=? WHERE scan_id=?', [
        replacement,
        original.scanId!,
      ]),
    );
    Object.assign(kit.env, { DB: intercepted.db });
    try {
      const replay = ScanOutcomeSchema.parse(
        await (await kit.post(scanner.headers, '/actions', request)).json(),
      );
      expect(intercepted.fired()).toBe(true);
      expect(replay).toMatchObject({
        kind: 'refused',
        reason: 'not_found',
        replay: false,
        scanId: null,
      });
    } finally {
      Object.assign(kit.env, { DB: real });
      await run(real, trigger.sql);
    }
  });

  it('checks both modes for passless misses but only the selected mode for pass receipts', async () => {
    const { kit, scanner, pass, request, original } = await fixture();
    const miss = {
      idempotencyKey: key(),
      input: { code: 'CROSS-MODE-MISSING-824', method: 'camera' as const },
      clientTs: kit.clock.now(),
      actionId: ACTION.id,
    };
    const missOriginal = ScanOutcomeSchema.parse(
      await (await kit.post(scanner.headers, '/actions', miss)).json(),
    );
    expect(missOriginal).toMatchObject({ reason: 'not_found', scanId: expect.any(String) });
    const [passRefs, missRefs] = await Promise.all([
      credentialTombstoneRefsForInput(kit.ctx, kit.org.id, 'live', request.input),
      credentialTombstoneRefsForInput(kit.ctx, kit.org.id, 'live', miss.input),
    ]);
    const testPass = await kit.scanPass(pass.templateId, {}, { mode: 'test' });
    const transferId = kit.fx.ids.id();
    await stagePendingCredentialTransfer(kit.env.DB, testPass.id, {
      id: transferId,
      token: kit.fx.ids.token(),
      now: kit.clock.now(),
      targetHolderEmail: 'other-mode@example.test',
    });
    for (const ref of [
      passRefs.otherModeCredentialTombstoneRefs[0],
      missRefs.otherModeCredentialTombstoneRefs[0],
    ]) {
      if (!ref) throw new Error('Missing opposite-mode credential reference');
      await run(
        kit.env.DB,
        `INSERT INTO pass_credential_tombstones
        (pass_id,org_id,mode,credential_generation,credential_kind,credential_hash,retired_at)
        SELECT pass_id,org_id,mode,source_generation,'serial',?,? FROM pass_credential_transfers WHERE id=?`,
        [ref, kit.clock.now(), transferId],
      );
    }
    const passReplay = ScanOutcomeSchema.parse(
      await (await kit.post(scanner.headers, '/actions', request)).json(),
    );
    expect(passReplay).toMatchObject({
      kind: 'ok',
      replay: true,
      scanId: original.scanId,
      action: { id: ACTION.id },
    });
    const missReplay = ScanOutcomeSchema.parse(
      await (await kit.post(scanner.headers, '/actions', miss)).json(),
    );
    expect(missReplay).toMatchObject({
      kind: 'refused',
      reason: 'not_found',
      replay: false,
      scanId: null,
    });
  });

  it('does not disclose a receipt if a same-mode credential is retired before the final CAS', async () => {
    const { kit, scanner, pass, request, original } = await fixture();
    const real = kit.env.DB;
    const refs = await credentialTombstoneRefsForInput(kit.ctx, kit.org.id, 'live', request.input);
    const ref = refs.credentialTombstoneRefs[0];
    if (!ref) throw new Error('Missing same-mode credential reference');
    const otherPass = await kit.scanPass(pass.templateId);
    const transferId = kit.fx.ids.id();
    await stagePendingCredentialTransfer(real, otherPass.id, {
      id: transferId,
      token: kit.fx.ids.token(),
      now: kit.clock.now(),
      targetHolderEmail: 'retired@example.test',
    });
    const before = await effectCounts(real, original.scanId!, pass.id);
    const intercepted = beforeReceiptCas(real, 'scan-ephemeral-source-event-json', () =>
      run(
        real,
        `INSERT INTO pass_credential_tombstones
        (pass_id,org_id,mode,credential_generation,credential_kind,credential_hash,retired_at)
        SELECT pass_id,org_id,mode,source_generation,'serial',?,? FROM pass_credential_transfers WHERE id=?`,
        [ref, kit.clock.now(), transferId],
      ),
    );
    Object.assign(kit.env, { DB: intercepted.db });
    try {
      const replay = ScanOutcomeSchema.parse(
        await (await kit.post(scanner.headers, '/actions', request)).json(),
      );
      expect(intercepted.fired()).toBe(true);
      expect(replay).toMatchObject({
        kind: 'refused',
        reason: 'not_found',
        replay: false,
        scanId: null,
      });
    } finally {
      Object.assign(kit.env, { DB: real });
    }
    expect(await effectCounts(real, original.scanId!, pass.id)).toEqual(before);
  });

  it('does not disclose a receipt if the captured keyset changes before the final CAS', async () => {
    const { kit, scanner, pass, request, original } = await fixture();
    const real = kit.env.DB;
    const keyset = await first<{ commitment: string }>(
      real,
      'SELECT commitment FROM credential_ref_keyset WHERE id=1',
    );
    const trigger = await first<{ sql: string }>(
      real,
      "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='credential_ref_keyset_no_update'",
    );
    if (!keyset || !trigger) throw new Error('Missing keyset guard');
    const before = await effectCounts(real, original.scanId!, pass.id);
    await run(real, 'DROP TRIGGER credential_ref_keyset_no_update');
    const replacement = keyset.commitment === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
    const intercepted = beforeReceiptCas(real, 'scan-ephemeral-source-event-json', () =>
      run(real, 'UPDATE credential_ref_keyset SET commitment=? WHERE id=1', [replacement]),
    );
    Object.assign(kit.env, { DB: intercepted.db });
    try {
      const replay = ScanOutcomeSchema.parse(
        await (await kit.post(scanner.headers, '/actions', request)).json(),
      );
      expect(intercepted.fired()).toBe(true);
      expect(replay).toMatchObject({
        kind: 'refused',
        reason: 'not_found',
        replay: false,
        scanId: null,
      });
    } finally {
      Object.assign(kit.env, { DB: real });
      await run(real, 'UPDATE credential_ref_keyset SET commitment=? WHERE id=1', [
        keyset.commitment,
      ]);
      await run(real, trigger.sql);
    }
    expect(await effectCounts(real, original.scanId!, pass.id)).toEqual(before);
  });
});
