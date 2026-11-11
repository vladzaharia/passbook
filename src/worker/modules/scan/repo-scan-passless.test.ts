import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { all, first, run } from '../../platform/db.ts';
import { readPasslessScans, scanPasslessSnapshotPredicate } from './repo-scan-passless.ts';
import { key, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let templateId: string;

beforeAll(async () => {
  kit = await setupScanKit();
  templateId = await kit.scanTemplate('Passless plain', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
});

async function miss(): Promise<string> {
  const scanner = await kit.scanner({ templateIds: [templateId] });
  const response = await kit.post(scanner.headers, '/actions', {
    idempotencyKey: key(),
    clientTs: kit.clock.now(),
    actionId: 'check_in',
    input: { code: `PLAIN-MISS-${key()}`, method: 'camera' },
  });
  expect(response.status).toBe(200);
  const result = (await response.json()) as ScanOutcome;
  if (!result.scanId) throw new Error('Missing refusal scan');
  return result.scanId;
}

describe('passless scans without proof tables', () => {
  it('has no passless proof table', async () => {
    const tables = await all<{ name: string }>(
      kit.env.DB,
      "SELECT name FROM sqlite_master WHERE name='scan_passless_proofs'",
    );
    expect(tables).toEqual([]);
  });

  it('reads a passless scan from its scans row, scoped by tenant and mode', async () => {
    const id = await miss();
    const other = await makeOrg(kit.fx, { name: 'Other passless tenant' });
    const ids = [id, ...Array.from({ length: 200 }, (_, i) => `missing-${i}`)];
    const found = await readPasslessScans(kit.env.DB, { orgId: kit.org.id, mode: 'live' }, ids);
    expect([...found.keys()]).toEqual([id]);
    expect(
      (await readPasslessScans(kit.env.DB, { orgId: other.id, mode: 'live' }, [id])).size,
    ).toBe(0);
    expect(
      (await readPasslessScans(kit.env.DB, { orgId: kit.org.id, mode: 'test' }, [id])).size,
    ).toBe(0);
    expect((await readPasslessScans(kit.env.DB, { mode: 'live' }, [id])).has(id)).toBe(true);
  });

  it('rebinds only while the scan row is unchanged and carries no pass evidence', async () => {
    const id = await miss();
    const found = (await readPasslessScans(kit.env.DB, { mode: 'live' }, [id])).get(id);
    if (!found) throw new Error('Missing passless scan');
    const pred = scanPasslessSnapshotPredicate('s', found);
    const holds = () =>
      first(kit.env.DB, `SELECT 1 AS ok FROM scans s WHERE s.id=? AND ${pred.sql}`, [
        id,
        ...pred.params,
      ]);
    expect(await holds()).toEqual({ ok: 1 });
    await run(kit.env.DB, 'UPDATE scans SET at=at+1 WHERE id=?', [id]);
    expect(await holds()).toBeNull();
  });

  it('stops matching once a pass is attached to the scan', async () => {
    const id = await miss();
    const before = await readPasslessScans(kit.env.DB, { mode: 'live' }, [id]);
    expect(before.has(id)).toBe(true);
    await run(kit.env.DB, "UPDATE scans SET reason='needs_approval' WHERE id=?", [id]);
    expect((await readPasslessScans(kit.env.DB, { mode: 'live' }, [id])).has(id)).toBe(false);
  });
});
