import { first } from '../../platform/db.ts';

export interface UndoneValue {
  amount: number | null;
  before: unknown;
  after: unknown;
}

/** What a value scan changed, as its row recorded it. */
export async function readScanValue(
  db: D1Database,
  orgId: string,
  scanId: string,
): Promise<UndoneValue | null> {
  const row = await first<{
    amount: number | null;
    before_value: string | null;
    after_value: string | null;
  }>(db, 'SELECT amount, before_value, after_value FROM scans WHERE id = ? AND org_id = ?', [
    scanId,
    orgId,
  ]);
  if (!row) return null;
  const parse = (text: string | null) => (text === null ? null : (JSON.parse(text) as unknown));
  return { amount: row.amount, before: parse(row.before_value), after: parse(row.after_value) };
}
