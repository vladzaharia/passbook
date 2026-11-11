import { expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getHolderPass } from '../holders/repo.ts';
import { startCredentialTransfer } from '../passes/credential-transfer.ts';
import { barcodeHashOfCode, cleanCode } from './codes.ts';
import { catchupFixture, isAcquisition } from './live-catchup-batch-test-fixtures.ts';
import { liveRowsFor } from './live-render.ts';
import { contextWithDb, traceLiveD1 } from './repo-live-photo-d1-trace-test-fixtures.ts';
import { setSetupWatchStmt } from './repo-setups-test-support.ts';
import { kit, template } from './scan-hub-test-fixtures.ts';

export function registerCatchupAuthorityRaceTests() {
  it('omits only the source whose original credential retires after acquisition', async () => {
    const fixture = await catchupFixture();
    const other = await kit.scanPass(template);
    const hash = await barcodeHashOfCode(cleanCode(fixture.inputs[0].code));
    await run(kit.env.DB, 'UPDATE passes SET barcode_hash=?,revision=revision+1 WHERE id=?', [
      hash,
      other.id,
    ]);
    const expected = await getHolderPass(kit.env.DB, other.id, null);
    if (!expected) throw new Error('Missing transfer snapshot.');
    let raced = false;
    const trace = traceLiveD1(kit.env.DB, async (statements, results) => {
      if (!isAcquisition(statements) || raced) return results;
      raced = true;
      const transfer = await startCredentialTransfer(
        jobCtxOf(kit),
        { type: 'system', id: null },
        other.id,
        { holderEmail: 'batch-new-holder@example.test', ownerUserId: null },
        null,
        { kind: 'tenant-holder', expected },
      );
      expect(transfer.state).toBe('completed');
      return results;
    });
    const rows = await liveRowsFor(
      contextWithDb(kit.ctx, trace.db),
      fixture.recipient,
      fixture.rows,
    );
    expect(raced).toBe(true);
    expect(
      await first(
        kit.env.DB,
        `SELECT 1 FROM pass_credential_tombstones
      WHERE org_id=? AND mode='live' AND credential_hash IN (SELECT value FROM json_each(?))`,
        [kit.org.id, JSON.stringify(fixture.proofs[0].credentialContext.credentialTombstoneRefs)],
      ),
    ).not.toBeNull();
    expect(rows.map((row) => row.id)).toEqual(fixture.rows.slice(1).map((row) => row.id));
    expect(rows[0]).toMatchObject({ passId: fixture.passes[1].id, holder: 'Catchup Photo' });
    if (!rows[0]) throw new Error('Missing photo row.');
    expect(rows[0].photoUrl).toBeTruthy();
    expect(JSON.stringify(rows)).not.toContain(fixture.inputs[0].code);
    expect(JSON.stringify(rows)).not.toContain(fixture.passes[0].id);
    expect(trace.trips.length).toBeLessThanOrEqual(5);
  }, 120_000);

  it.each(['recipient-revoked', 'recipient-csrf', 'watch', 'tenant'] as const)(
    'rechecks the shared %s after acquisition and discloses no row or token',
    async (change) => {
      const fixture = await catchupFixture();
      let raced = false;
      const trace = traceLiveD1(kit.env.DB, async (statements, results) => {
        if (!isAcquisition(statements) || raced) return results;
        raced = true;
        if (change === 'recipient-revoked')
          await run(kit.env.DB, 'UPDATE scanners SET revoked_at=? WHERE id=?', [
            kit.clock.now(),
            fixture.monitor.id,
          ]);
        else if (change === 'recipient-csrf')
          await run(
            kit.env.DB,
            'UPDATE scanners SET csrf_secret=?,updated_at=updated_at+1 WHERE id=?',
            [`new-${kit.ctx.ids.token()}`, fixture.monitor.id],
          );
        else if (change === 'watch')
          await setSetupWatchStmt(kit.env.DB, kit.org.id, fixture.monitor.id, {
            scannerIds: fixture.sources.slice(1).map((source) => source.id),
            allOrg: false,
          }).run();
        else
          await run(
            kit.env.DB,
            "UPDATE orgs SET status='suspended',updated_at=updated_at+1 WHERE id=?",
            [kit.org.id],
          );
        return results;
      });
      try {
        expect(
          await liveRowsFor(contextWithDb(kit.ctx, trace.db), fixture.recipient, fixture.rows),
        ).toEqual([]);
        expect(raced).toBe(true);
        expect(trace.trips.length).toBeLessThanOrEqual(5);
      } finally {
        if (change === 'tenant')
          await run(
            kit.env.DB,
            "UPDATE orgs SET status='active',updated_at=updated_at+1 WHERE id=?",
            [kit.org.id],
          );
      }
    },
  );

  it('omits a forged or crossed source proof while retaining other original rows', async () => {
    const fixture = await catchupFixture();
    const original = fixture.rows[0];
    const malformed =
      original.sourceProof.slice(0, 3) +
      (original.sourceProof[3] === 'A' ? 'B' : 'A') +
      original.sourceProof.slice(4);
    for (const invalid of [
      { ...original, sourceProof: malformed },
      { ...original, sourceProof: fixture.rows[1].sourceProof },
      { ...original, scannerId: fixture.rows[1].scannerId },
      { ...original, at: original.at + 1 },
      { ...original, passId: fixture.passes[1].id },
    ]) {
      const rows = await liveRowsFor(kit.ctx, fixture.recipient, [
        invalid,
        ...fixture.rows.slice(1),
      ]);
      expect(rows.map((row) => row.id)).toEqual(fixture.rows.slice(1).map((row) => row.id));
      expect(rows[0]).toMatchObject({ passId: fixture.passes[1].id, holder: 'Catchup Photo' });
      if (!rows[0]) throw new Error('Missing photo row.');
      expect(rows[0].photoUrl).toBeTruthy();
      expect(JSON.stringify(rows)).not.toContain(fixture.passes[0].id);
    }
  });
}
