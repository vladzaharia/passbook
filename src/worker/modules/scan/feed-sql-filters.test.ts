import { describe, expect, it } from 'vitest';
import { makeScanner } from '../../../../test/helpers/index.ts';
import {
  f,
  get,
  items,
  orgId,
  passId,
  recordedAction,
  scannerFixture,
  scannerId,
  template,
} from './repo-scans-split-test-fixtures.ts';

describe('GET /scans filters', () => {
  it('apply in SQL, so a filtered page is not emptied by newer rows of other scanners', async () => {
    const wanted = await recordedAction(scannerFixture, passId);
    const other = await makeScanner(f, { orgId, templateIds: [template.resolved.id] });
    for (let i = 0; i < 55; i++) await recordedAction(other, passId);
    const res = await get(`?orgId=${orgId}&scannerId=${scannerId}&limit=1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string }[]; nextCursor: string | null };
    expect(body.items.map((row) => row.id)).toEqual([wanted.id]);
    expect(body.nextCursor).toBeNull();
    expect((await items(await get(`?orgId=${orgId}&limit=100`))).length).toBe(56);
  }, 60_000);
});
