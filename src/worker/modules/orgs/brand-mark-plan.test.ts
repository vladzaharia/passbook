import { describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { retentionKit } from '../retention/retention-test-fixtures.ts';
import { orgBrandOf } from './brand.ts';
import { effectiveMark, marksOf } from './brand-mark.ts';

describe('marksOf and effectiveMark', () => {
  it('reads the least a plan shows, failing closed to full', () => {
    expect(marksOf('full')).toEqual(['full']);
    expect(marksOf('quiet')).toEqual(['small', 'full']);
    expect(marksOf('none')).toEqual(['none', 'small', 'full']);
    expect(marksOf(undefined)).toEqual(['full']);
    expect(marksOf('bogus')).toEqual(['full']);
    expect(marksOf(1)).toEqual(['full']);
  });

  it('falls to the nearest allowed mark with more PassBook', () => {
    expect(effectiveMark('none', ['small', 'full'])).toBe('small');
    expect(effectiveMark('none', ['full'])).toBe('full');
    expect(effectiveMark('small', ['full'])).toBe('full');
    expect(effectiveMark('small', ['none', 'small', 'full'])).toBe('small');
    expect(effectiveMark(undefined, ['none', 'small', 'full'])).toBe('full');
  });
});

describe('a plan change never rewrites the stored footer choice', () => {
  it('shows the nearest allowed mark now, and the choice resumes when the plan allows it again', async () => {
    const rk = await retentionKit();
    const { orgId } = await rk.org(['org_admin']);
    const db = rk.kit.env.DB;
    await run(db, 'UPDATE orgs SET branding = ? WHERE id = ?', [
      JSON.stringify({ mark: 'none' }),
      orgId,
    ]);
    const plan = (value: string) =>
      run(
        db,
        "INSERT OR REPLACE INTO org_entitlement_overrides (org_id, key, value, updated_at) VALUES (?, 'brand.mark', ?, 1)",
        [orgId, JSON.stringify(value)],
      );
    const shown = async () => (await orgBrandOf(rk.kit.ctx, orgId)).mark;
    const stored = async () =>
      JSON.parse(
        (await first<{ b: string }>(db, 'SELECT branding AS b FROM orgs WHERE id = ?', [orgId]))
          ?.b ?? '{}',
      ).mark;
    await plan('full');
    expect(await shown()).toBe('full');
    await plan('quiet');
    expect(await shown()).toBe('small');
    await plan('none');
    expect(await shown()).toBe('none');
    expect(await stored()).toBe('none');
  });
});
