import { all, first, run } from '../../platform/db.ts';
import { PIN_PERSON_WINDOW_MS, PIN_SCANNER_WINDOW_MS } from './staff-pin.ts';
import type { ScanKit } from './test-kit.ts';

const windowOf = (now: number, size: number) => now - (now % size);
const personKey = (scanner: string, staff: string) => `scan:pin:${scanner}:${staff}`;
const scannerKey = (scanner: string) => `scan:pinall:${scanner}`;

export async function counts(kit: ScanKit, scanner: string, staff: string) {
  const now = kit.clock.now();
  const value = async (k: string, window: number) =>
    (
      await first<{ count: number }>(
        kit.env.DB,
        'SELECT count FROM counters WHERE key=? AND window_start=?',
        [k, window],
      )
    )?.count ?? 0;
  return {
    person: await value(personKey(scanner, staff), windowOf(now, PIN_PERSON_WINDOW_MS)),
    scanner: await value(scannerKey(scanner), windowOf(now, PIN_SCANNER_WINDOW_MS)),
  };
}

export async function seedCounts(
  kit: ScanKit,
  scanner: string,
  staff: string,
  person: number,
  total: number,
) {
  const now = kit.clock.now();
  for (const [k, window, count] of [
    [personKey(scanner, staff), windowOf(now, PIN_PERSON_WINDOW_MS), person],
    [scannerKey(scanner), windowOf(now, PIN_SCANNER_WINDOW_MS), total],
  ] as const) {
    await run(kit.env.DB, 'INSERT INTO counters (key,window_start,count) VALUES (?,?,?)', [
      k,
      window,
      count,
    ]);
  }
}

export async function effects(kit: ScanKit, passId: string) {
  return {
    gates: await all(
      kit.env.DB,
      'SELECT * FROM scan_gates WHERE pass_id=? ORDER BY action_id,scope',
      [passId],
    ),
    presence: await all(kit.env.DB, 'SELECT * FROM scan_presence WHERE pass_id=? ORDER BY scope', [
      passId,
    ]),
    scans: await all(
      kit.env.DB,
      "SELECT * FROM scans WHERE pass_id=? AND state='done' ORDER BY id",
      [passId],
    ),
    events: await all(
      kit.env.DB,
      "SELECT * FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%' ORDER BY id",
      [passId],
    ),
  };
}
