import { describe, expect, it } from 'vitest';
import { grant, prepareGrantForTest } from './authority.ts';
import { exactlyOne } from './authority-checks.ts';
import { exists, notExists } from './authority-cond.ts';
import { codeOf, count, db, noGrants, refusal } from './authority-ext-fixtures.ts';
import { setupGrant } from './authority-test-fixtures.ts';
import { DENY_REASONS } from './errors.ts';

const KEY = ['key', 'value', 'updated_at'];
const none = (key: string) => count('SELECT count(*) AS n FROM settings WHERE key = ?', [key]);

describe('D: g.assert', () => {
  it('a passing assert commits and leaves no grant row (13)', async () => {
    const { route, member } = await setupGrant('as-pass');
    const g = grant(route, { purpose: 'org.test.as', principal: member({ mode: undefined }) });
    g.insertSelect('settings', KEY, ['as-k', '1', 1]);
    g.assert('stale', [exists('settings', { key: 'as-k' })]);
    await g.commit();
    expect(await none('as-k')).toBe(1);
    expect(await noGrants()).toBe(0);
  });

  it('a failing assert aborts with the reason, applies the codes and rolls back earlier writes (14)', async () => {
    const { route, member } = await setupGrant('as-fail');
    const codes = Object.fromEntries(DENY_REASONS.map((r) => [r, `ASSERT_${r.toUpperCase()}`]));
    for (const reason of DENY_REASONS) {
      const g = grant(route, {
        purpose: 'org.test.as',
        principal: member({ mode: undefined }),
        codes,
      });
      g.insertSelect('settings', KEY, [`as-${reason}`, '1', 1]);
      g.assert(reason, [exists('settings', { key: 'never' })]);
      expect(await refusal(g.commit()), reason).toMatchObject({
        code: `ASSERT_${reason.toUpperCase()}`,
      });
      expect(await none(`as-${reason}`), reason).toBe(0);
      expect(await noGrants()).toBe(0);
    }
    const raw = grant(route, { purpose: 'org.test.as', principal: member({ mode: undefined }) });
    raw.assert('stale', [exists('settings', { key: 'never' })]);
    await expect(db.batch(prepareGrantForTest(raw))).rejects.toThrow(/authority_denied:stale/);
    expect(codeOf(() => raw.assert('nope' as never, [exists('settings', { key: 'x' })]))).toBe(
      'GRANT_BAD_PURPOSE',
    );
    expect(codeOf(() => raw.assert('stale', []))).toBe('GRANT_BAD_PURPOSE');
  });

  it('when false skips the assert; the assert sees earlier statements of its batch (15)', async () => {
    const { route, member } = await setupGrant('as-when');
    const mk = () =>
      grant(route, { purpose: 'org.test.as', principal: member({ mode: undefined }) });
    const skipped = mk();
    skipped.assert('stale', [exists('settings', { key: 'never' })], {
      when: [exists('settings', { key: 'never-either' })],
    });
    await skipped.commit();
    const sees = mk();
    sees.insertSelect('settings', KEY, ['as-seen', '1', 1]);
    sees.assert('stale', [exists('settings', { key: 'as-seen' })]);
    await sees.commit();
    const unseen = mk();
    unseen.insertSelect('settings', KEY, ['as-unseen', '1', 1]);
    unseen.assert('lineage', [notExists('settings', { key: 'as-unseen' })]);
    expect(await refusal(unseen.commit())).toMatchObject({ code: 'LINEAGE_CHANGED' });
    expect(await none('as-unseen')).toBe(0);
  });

  it("a failing check beats an assert: the refusal is the check's (16)", async () => {
    const { route, member } = await setupGrant('as-order');
    const g = grant(route, {
      purpose: 'org.test.as',
      principal: member({ mode: undefined }),
      checks: [exactlyOne('settings', { key: 'missing' }, undefined, 'config')],
      codes: { config: 'FROM_CHECK', stale: 'FROM_ASSERT' },
    });
    g.assert('stale', [exists('settings', { key: 'never' })]);
    expect(await refusal(g.commit())).toMatchObject({ code: 'FROM_CHECK' });
  });
});
