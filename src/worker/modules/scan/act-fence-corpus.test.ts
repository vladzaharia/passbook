import { beforeAll, describe, expect, it } from 'vitest';
import { claimOfCorpus } from './act-fence-corpus-test-fixtures.ts';
import { type ScanActor, scannerActor, withRole } from './actor.ts';
import { approvalReservationPredicate } from './repo-act-approval.ts';
import { invalidAttemptAuthority } from './repo-act-attempt-authority.ts';
import { getScanner } from './repo-device.ts';
import { candidateById } from './repo-lookup.ts';
import { scanRead, scanReadAuthority } from './repo-read-authority.ts';
import { passAnswerFence, underAuthorityCtes } from './repo-read-fences.ts';
import { pristineClaimFence, releaseClaimStmt } from './repo-scans.ts';
import { getEvent, readScannerScope } from './repo-scope.ts';
import { foundOf } from './resolve.ts';
import { scanEpochsOf, setScanEpochs } from './scan-epochs.ts';
import { preparePinReservation } from './staff-pin.ts';
import { proofedScanActor, type ScanKit, setupScanKit } from './test-kit.ts';

/*
 * The act path's fences are plain SQL (no packing): the widest actor, an event-bound scanner with
 * a second event, plus a pass fence and the claim fence, stays under D1's bind limit and compiles
 * as a guard of the statements that carry it.
 */

let kit: ScanKit;
beforeAll(async () => {
  kit = await setupScanKit();
});

describe('act fences at their widest shape', () => {
  // `widest`: the pass is admitted under an event that is not the scanner's, in a session, with a staff member bound.
  it.each(['event-bound', 'widest'] as const)(
    'the invalid-action guard, the PIN reservation guard and the replay fence fit D1 and answer (%s)',
    async (shape) => {
      const templateId = await kit.scanTemplate('Act fence corpus', {
        actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
      });
      const event = await kit.event({ templateIds: [templateId] });
      const scanner = await kit.scanner({ eventId: event.id, templateIds: [templateId] });
      const pass = await kit.scanPass(templateId);
      const row = await getScanner(kit.env.DB, scanner.id);
      const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
      if (!row || !candidate) throw new Error('Missing fixture');
      const scope = await readScannerScope(kit.env.DB, row, null);
      const real = await proofedScanActor(
        kit.ctx,
        withRole(scannerActor(kit.ctx, row, row.mode, 'cookie', scope), null),
      );
      const actor: ScanActor = shape === 'event-bound' ? real : { ...real };
      if (shape === 'widest') {
        const epochs = scanEpochsOf(real);
        if (!epochs || !actor.scanner) throw new Error('Missing epochs');
        actor.scanningSession = { id: 'ss-1', status: 'active', updatedAt: 1 };
        actor.staff = { id: 'staff-1' } as never;
        actor.scanner = { ...actor.scanner, staffId: 'staff-1' };
        setScanEpochs(actor, {
          ...structuredClone(epochs),
          session: { id: 'ss-1', config: 1 },
          staff: { id: 'staff-1', auth: 1 },
        });
      }
      const loaded = await foundOf(kit.ctx, candidate, real);
      if (!loaded) throw new Error('Missing found');
      const other = shape === 'widest' ? await kit.event({ templateIds: [templateId] }) : null;
      const admitted = other ? await getEvent(kit.env.DB, kit.org.id, other.id) : null;
      const found = admitted ? { ...loaded, admission: { event: admitted } as never } : loaded;
      const refs = found.credentialTombstoneRefs;
      const claim = claimOfCorpus(kit, actor);
      const now = kit.clock.now();

      const invalid = invalidAttemptAuthority(
        kit.ctx,
        actor,
        {
          credentialTombstoneRefs: refs,
          credentialKeysetCommitment: found.credentialKeysetCommitment,
        } as never,
        claim,
        found,
      );
      // The guard of the claim's release: its CTEs lead the statement, so the fence's depth stays out of the DELETE's WHERE.
      expect(invalid.ctes).toBeDefined();
      const release = releaseClaimStmt(kit.env.DB, 'no-such-scan', now, invalid);
      expect((await release.all()).results).toEqual([]);

      const inner = passAnswerFence(actor, candidate, { photo: false, refs, staged: true });
      if (!inner) throw new Error('Missing pass fence');
      const staged = underAuthorityCtes(
        scanReadAuthority(actor, { now, event: found.admission?.event ?? null, templateId }),
        inner,
      );
      const guard = approvalReservationPredicate('scan-1', now, pristineClaimFence(claim), {
        sql: staged.sql,
        params: [],
        ctes: staged.ctes,
        cteParams: staged.params,
      });
      // Every counter statement of a PIN reservation carries the guard; each compiles and holds the budget.
      const reservation = preparePinReservation(
        kit.ctx,
        { scannerId: scanner.id, orgId: kit.org.id, staffId: 'any-manager' },
        guard,
      );
      expect(reservation.stmts.length).toBeGreaterThan(0);
      const results = await kit.env.DB.batch(reservation.stmts);
      // No pending claim 'scan-1': nothing was counted.
      expect(results.every((result) => result.results.length === 0)).toBe(true);

      // The replay projection's fence is inline in a top-level read: it compiles at this shape too.
      const plain = passAnswerFence(actor, candidate, { photo: false, refs });
      if (!plain) throw new Error('Missing pass fence');
      const auth = scanReadAuthority(actor, {
        now,
        event: found.admission?.event ?? null,
        templateId,
      });
      const projection = scanRead(
        kit.env.DB,
        auth,
        `SELECT 1 AS authorized FROM actor_ok ao WHERE ${auth.present} AND ${plain.sql}`,
        plain.params,
      );
      expect((await projection.all()).results.length).toBeLessThanOrEqual(1);
    },
  );
});
