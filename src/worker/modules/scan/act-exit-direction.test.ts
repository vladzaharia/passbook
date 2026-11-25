import { describe, expect, it } from 'vitest';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { first } from '../../platform/db.ts';
import { kit, templateId } from './repo-undo-authority-test-fixtures.ts';
import { codeOf, key } from './test-kit.ts';

describe('an exit under Track in / out', () => {
  it('answers and records the second scan as an out', async () => {
    const scanner = await kit.scanner({
      templateIds: [templateId],
      settings: { checkIn: { mode: 'in_out' }, direction: 'both' },
    });
    const pass = await kit.scanPass(templateId);
    const scan = async () =>
      (await (
        await kit.post(scanner.headers, '/actions', {
          idempotencyKey: key(),
          input: codeOf(pass),
          clientTs: kit.clock.now(),
          actionId: 'enter',
        })
      ).json()) as ScanOutcome;
    const entry = await scan();
    const exit = await scan();
    expect(entry).toMatchObject({ kind: 'ok', checkIn: { direction: 'in' } });
    expect(exit).toMatchObject({ kind: 'ok', checkIn: { direction: 'out' } });
    expect(entry.action?.label).toBe('Check in');
    expect(exit.action?.label).toBe('Check out');
    const row = await first<{ direction: string; action_kind: string }>(
      kit.env.DB,
      'SELECT direction, action_kind FROM scans WHERE id=?',
      [exit.scanId],
    );
    expect(row).toEqual({ direction: 'out', action_kind: 'check_in' });
    const ev = await first<{ data: string }>(
      kit.env.DB,
      "SELECT data FROM pass_events WHERE pass_id=? AND kind='scan.checked_out'",
      [pass.id],
    );
    expect(JSON.parse(ev?.data ?? '{}')).toMatchObject({ direction: 'out', exit: 'scan' });
    const recent = (await (await kit.get(scanner.headers, '/scans')).json()) as {
      items: { scanId: string; actionLabel: string }[];
    };
    expect(recent.items.find((i) => i.scanId === exit.scanId)?.actionLabel).toBe('Check out');
    expect(recent.items.find((i) => i.scanId === entry.scanId)?.actionLabel).toBe('Check in');
  });
});
