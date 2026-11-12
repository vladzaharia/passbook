import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { normalizeLookup } from '../../../shared/scan-lookup.ts';
import { run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { act } from './act.ts';
import { scannerActor, withRole } from './actor.ts';
import { publishScan } from './live.ts';
import { type InternalLiveRow, openLiveSourceProof } from './live-provenance.ts';
import { getScanner } from './repo-device.ts';
import { readScannerScope } from './repo-scope.ts';
import { hub, kit, screen, template } from './scan-hub-test-fixtures.ts';
import { bindScanningSession } from './scanning-workspace.ts';
import { codeOf, key, proofedScanActor } from './test-kit.ts';

describe('ambiguous live event privacy', () => {
  it('publishes duplicate-window ambiguity and foreign-tenant misses without associating a pass', async () => {
    const event = await kit.event({ templateIds: [template] });
    const source = await kit.scanner({ eventId: event.id, templateIds: [template] });
    const monitor = await screen('monitor', [source.id]);
    const scanner = await getScanner(kit.env.DB, source.id);
    if (!scanner) throw new Error('Missing source device.');
    const scope = await readScannerScope(kit.env.DB, scanner, scanner.staffId);
    const base = scannerActor(kit.ctx, scanner, 'live', 'cookie', scope);
    await bindScanningSession(kit.ctx, base);
    const actor = await proofedScanActor(kit.ctx, withRole(base, null));
    const first = await kit.scanPass(template, { memberName: 'First private ambiguous holder' });
    const second = await kit.scanPass(template, { memberName: 'Second private ambiguous holder' });
    const code = `SHARED-${kit.ctx.ids.token()}`;
    const hash = await sha256Hex(normalizeLookup(code));
    for (const pass of [first, second])
      await run(kit.env.DB, 'UPDATE passes SET lookup_hash=? WHERE id=?', [hash, pass.id]);
    const foreignOrg = await makeOrg(kit.fx, { name: 'Foreign live tenant' });
    const foreignTemplate = await kit.scanTemplate(
      'Foreign live pass',
      {
        actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
      },
      { orgId: foreignOrg.id },
    );
    const foreign = await kit.scanPass(
      foreignTemplate,
      { memberName: 'Foreign private holder' },
      { orgId: foreignOrg.id },
    );
    if (!foreign.scanCode) throw new Error('Missing foreign credential.');

    const outcomes = [];
    for (const input of [
      { code, method: 'wedge' as const },
      { code, method: 'wedge' as const },
      codeOf(foreign),
    ]) {
      const result = await act(kit.ctx, actor, {
        input,
        actionId: 'auto',
        clientTs: kit.clock.now(),
        idempotencyKey: key(),
      });
      outcomes.push(result.outcome);
      expect(result.evaluatedSnapshot).toBeNull();
      expect(result.credentialContext).toBeTruthy();
      publishScan(
        kit.ctx,
        actor,
        result.outcome,
        result.evaluatedSnapshot,
        result.credentialContext,
        input.method,
      );
    }
    await kit.settle();
    expect(outcomes.map((outcome) => outcome.reason)).toEqual([
      'ambiguous',
      'ambiguous',
      'not_found',
    ]);
    const rows = (await hub().snapshot(monitor.attachment)).rows.filter(
      (row) => row.scannerId === source.id,
    );
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.id)).size).toBe(3);
    expect(new Set(rows.map((row) => row.at)).size).toBe(1);
    for (const row of rows) {
      expect(row).toMatchObject({ kind: 'refused', passId: null, holder: null, photoUrl: null });
      expect(row).not.toHaveProperty('sourceProof');
      const sealed = await hub().sourceProof(row.id);
      if (!sealed) throw new Error('Missing passless proof.');
      const proof = await openLiveSourceProof(kit.env, sealed);
      expect(proof).toMatchObject({ eventId: row.id, passId: null, passSnapshot: null });
    }
    const internal = await runInDurableObject(hub(), async (_object, state) =>
      ((await state.storage.get<InternalLiveRow[]>('recent')) ?? []).filter(
        (row) => row.scannerId === source.id,
      ),
    );
    expect(internal).toHaveLength(3);
    const publicBytes = JSON.stringify({ outcomes, rows, internal });
    for (const secret of [
      first.id,
      second.id,
      foreign.id,
      first.serial,
      second.serial,
      foreign.serial,
      first.scanCode,
      second.scanCode,
      foreign.scanCode,
      code,
      'First private ambiguous holder',
      'Second private ambiguous holder',
      'Foreign private holder',
    ]) {
      if (secret) expect(publicBytes).not.toContain(secret);
    }
  });
});
