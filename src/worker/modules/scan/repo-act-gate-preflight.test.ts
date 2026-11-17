import { beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import type { ScanActor } from './guard.ts';
import { heldGateCapacityStmt } from './repo-act-gate-preflight.ts';
import { codeOf, key, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let templateId: string;

beforeAll(async () => {
  kit = await setupScanKit();
  templateId = await kit.scanTemplate('Held capacity', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'always' }],
  });
});

/** The held-gate capacity read counts only the event's live occupants, however many scans the ledger holds. */
describe('held gate capacity is read from the live occupants', () => {
  it('is full for another pass only while an occupant is live, and never for the occupant', async () => {
    const event = await kit.event({ templateIds: [templateId] });
    await run(kit.env.DB, 'UPDATE scan_events SET capacity=1 WHERE id=?', [event.id]);
    const scanner = await kit.scanner({ eventId: event.id });
    const [occupant, other] = [await kit.scanPass(templateId), await kit.scanPass(templateId)];
    const full = async (passId: string) => {
      const row = await heldGateCapacityStmt(
        kit.env.DB,
        { orgId: kit.org.id, mode: 'live' } as ScanActor,
        { passId, actionId: 'check_in', scope: 'event' },
        event.id,
      ).first<{ full: number }>();
      return row?.full;
    };
    expect(await full(other.id)).toBe(0);
    const entered = await kit.post(scanner.headers, '/actions', {
      input: codeOf(occupant),
      idempotencyKey: key(),
      clientTs: kit.clock.now(),
      actionId: 'check_in',
    });
    expect(entered.status).toBe(200);
    const { scanId } = (await entered.json()) as { scanId: string };
    expect(await full(other.id)).toBe(1);
    expect(await full(occupant.id)).toBe(0);
    // A witness that is no longer live (its scan undone) stops counting.
    await run(kit.env.DB, 'UPDATE scans SET undone_by = ?, undone_at = 1 WHERE id = ?', [
      'undo-scan',
      scanId,
    ]);
    expect(await full(other.id)).toBe(0);
  });
});
