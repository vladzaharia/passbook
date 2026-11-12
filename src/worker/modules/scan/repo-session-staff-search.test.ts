import { describe, expect, it } from 'vitest';
import { ScanStaffSearchSchema } from '../../../shared/contracts/scan-session.ts';
import { setupScanKit } from './test-kit.ts';

describe('staff name search', () => {
  it('matches any part of a name, case-insensitively and literally, at the longest query', async () => {
    const kit = await setupScanKit();
    const scanner = await kit.scanner({ settings: { staffSignIn: true } });
    const long = `Harbor ${'Wide '.repeat(16)}Alice`;
    const person = await kit.staff('door', long);
    const literal = await kit.staff('door', 'Promo 100% off_now');
    await kit.staff('door', 'Promo 1000 offXnow');
    const search = async (q: string) => {
      const response = await kit.get(scanner.headers, `/staff?q=${encodeURIComponent(q)}`);
      expect(response.status).toBe(200);
      return ScanStaffSearchSchema.parse(await response.json()).items.map((item) => item.id);
    };
    const query = long.slice(3, 83);
    expect(query).toHaveLength(80);
    expect(await search(query.toUpperCase())).toEqual([person.id]);
    expect(await search(`${query.slice(0, -1)}X`)).toEqual([]);
    expect(await search('100% off_')).toEqual([literal.id]);
  });
});
