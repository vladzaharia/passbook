import { describe, expect, it } from 'vitest';
import { grant } from './authority.ts';
import { exists } from './authority-cond.ts';
import { count, db, noGrants, refusal } from './authority-ext-fixtures.ts';
import { receiptStatement } from './authority-receipt.ts';
import { setupGrant } from './authority-test-fixtures.ts';

const KEY = ['key', 'value', 'updated_at'];
const none = (key: string) => count('SELECT count(*) AS n FROM settings WHERE key = ?', [key]);
const caller = (key: string, scope = 'platform') =>
  db
    .prepare("INSERT INTO settings (scope, key, value, updated_at) VALUES (?, ?, '1', 1)")
    .bind(scope, key);

describe('Grant.commitAfter', () => {
  it('caller statements run first in the same transaction as the grant', async () => {
    const { s, route, member } = await setupGrant('ca-ok');
    const g = grant(route, { purpose: 'org.test.ca', principal: member({ mode: undefined }) });
    g.insertSelect('settings', KEY, ['ca-grant', '1', 1]);
    // The gate sees the caller's row, so it ran earlier in the batch.
    g.assert('stale', [exists('settings', { key: 'ca-caller' })]);
    const results = await g.commitAfter(receiptStatement(caller('ca-caller', `org:${s.org.id}`)));
    expect(results).toHaveLength(2);
    expect(await none('ca-caller')).toBe(1);
    expect(await none('ca-grant')).toBe(1);
    expect(await noGrants()).toBe(0);
  });

  it('a failing gate rolls back the caller statements', async () => {
    const { route, member } = await setupGrant('ca-gate');
    const g = grant(route, { purpose: 'org.test.ca', principal: member({ mode: undefined }) });
    g.insertSelect('settings', KEY, ['ca-gated', '1', 1]);
    g.assert('stale', [exists('settings', { key: 'never' })]);
    await refusal(g.commitAfter(receiptStatement(caller('ca-rolled'))));
    expect(await none('ca-rolled')).toBe(0);
    expect(await none('ca-gated')).toBe(0);
    expect(await noGrants()).toBe(0);
  });

  it('a failing caller statement rolls back the gated writes', async () => {
    const { route, member } = await setupGrant('ca-fail');
    const g = grant(route, { purpose: 'org.test.ca', principal: member({ mode: undefined }) });
    g.insertSelect('settings', KEY, ['ca-never', '1', 1]);
    const bad = db.prepare(
      "INSERT INTO settings (scope, key, value, updated_at) VALUES (NULL, 'ca-bad', '1', 1)",
    );
    await expect(g.commitAfter(receiptStatement(bad))).rejects.toThrow();
    expect(await none('ca-never')).toBe(0);
    expect(await noGrants()).toBe(0);
  });

  it('refuses a statement that is not a retention receipt', async () => {
    const { route, member } = await setupGrant('ca-foreign');
    const g = grant(route, { purpose: 'org.test.ca', principal: member({ mode: undefined }) });
    g.insertSelect('settings', KEY, ['ca-foreign-k', '1', 1]);
    await expect(g.commitAfter(caller('ca-raw') as never)).rejects.toMatchObject({
      code: 'GRANT_FOREIGN_STATEMENT',
    });
    expect(await none('ca-raw')).toBe(0);
  });
});
