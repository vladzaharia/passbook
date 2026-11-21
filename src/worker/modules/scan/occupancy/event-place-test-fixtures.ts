import { expect } from 'vitest';
import type { ScannerFixture } from '../../../../../test/helpers/index.ts';
import type { ScanOutcome } from '../../../../shared/contracts/scan.ts';
import { all, first, run } from '../../../platform/db.ts';
import { codeOf, key, type ScanKit, setupScanKit } from '../test-kit.ts';

export type Pass = Awaited<ReturnType<ScanKit['scanPass']>>;

/** A re-entry event with a scanner per direction, on the real scan stack. */
export async function eventPlaceKit() {
  const kit = await setupScanKit();
  const templateId = await kit.scanTemplate('Event place', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'always' }],
  });
  const baseline = kit.clock.now();
  const event = async (o: { capacity?: number; hardLimit?: boolean } = {}) => {
    const e = await kit.event({ templateIds: [templateId] });
    await run(kit.env.DB, 'UPDATE scan_events SET capacity=?, reentry=1, hard_limit=? WHERE id=?', [
      o.capacity ?? null,
      o.hardLimit ? 1 : 0,
      e.id,
    ]);
    return e;
  };
  const door = (
    eventId: string,
    direction: 'in' | 'out' | 'both' = 'in',
  ): Promise<ScannerFixture> => kit.scanner({ eventId, settings: { direction } });
  const act = async (scanner: ScannerFixture, pass: Pass): Promise<ScanOutcome> => {
    const response = await kit.post(scanner.headers, '/actions', {
      input: codeOf(pass),
      idempotencyKey: key(),
      clientTs: kit.clock.now(),
      actionId: 'check_in',
    });
    expect(response.status).toBe(200);
    return (await response.json()) as ScanOutcome;
  };
  const row = (pass: Pass, eventId: string) =>
    first<{ state: string; tracking: number; last_scan_id: string; due_at: number | null }>(
      kit.env.DB,
      'SELECT state, tracking, last_scan_id, due_at FROM scan_presence WHERE pass_id=? AND scope=?',
      [pass.id, `event:${eventId}`],
    );
  const inside = async (eventId: string) =>
    (
      await all<{ n: number }>(
        kit.env.DB,
        "SELECT count(*) AS n FROM scan_presence WHERE scope=? AND state='in'",
        [`event:${eventId}`],
      )
    )[0]?.n ?? 0;
  return {
    kit,
    templateId,
    baseline,
    event,
    door,
    act,
    row,
    inside,
    pass: () => kit.scanPass(templateId),
  };
}
