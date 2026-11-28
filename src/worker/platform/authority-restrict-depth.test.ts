// D1 refuses a statement whose expression tree is deeper than 100 ("Expression tree is too large"); the local
// workerd D1 enforces the same limit. A limited key's statements inline `key_templates` (0152, 0195: the view
// adds the parent's limits), and the view's depth adds to the statement's. Each table's condition is prepared
// here inside HEADROOM extra levels, so a view or reference that grows fails this test instead of a route.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { apiKeyReadAuthority, scanAuthorizedStmt } from '../modules/scan/repo-read-authority.ts';
import { readStaffActivity } from '../modules/scan/repo-staff-activity.ts';
import { authorityPredicate } from './authority-read.ts';
import { assertActorOnce } from './authority-read-once.ts';
import { restrictRow, TEMPLATE_REFS } from './authority-restrict.ts';
import { all } from './db.ts';

/**
 * Levels a real statement may put around the condition (grant wrappers, EXISTS, joins), with margin. The deepest
 * condition measured fits 47 more levels, so this fails when a view or reference grows by about 20.
 */
const HEADROOM = 25;

const wrap = (condition: string, levels: number): string =>
  Array.from({ length: levels }).reduce<string>((inner) => `(1=1 AND ${inner})`, condition);

const fits = (table: string, levels: number) =>
  all(
    env.DB,
    `SELECT 1 FROM ${table} t JOIN (SELECT NULL AS limit_key) g WHERE ${wrap(
      restrictRow(table, 't', 'g.limit_key').replace(/^ AND /, ''),
      levels,
    )} LIMIT 1`,
    [],
  ).then(
    () => true,
    () => false,
  );

describe('limited-key conditions leave depth headroom on D1', () => {
  it.each(Object.keys(TEMPLATE_REFS))('%s', async (table) => {
    expect(await fits(table, HEADROOM)).toBe(true);
  });

  it('the probe measures something: the deepest table stops fitting before 100 levels', async () => {
    const deepest = 'webhook_deliveries';
    expect(await fits(deepest, 100)).toBe(false);
    let lo = HEADROOM;
    let hi = 100;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (await fits(deepest, mid)) lo = mid;
      else hi = mid;
    }
    expect(lo).toBeGreaterThan(HEADROOM);
    expect(lo).toBeLessThan(100);
  });
});

describe('the join-once tenant filter', () => {
  const p = authorityPredicate(
    { kind: 'scanner', scannerId: 's', credentialEpoch: 1 },
    { scope: 'org_mode', now: 1 },
  );

  it.each(Object.keys(TEMPLATE_REFS))('%s reads the actor only through ao, and no CTE', (table) => {
    const text = p.tenant('x', table);
    expect(text).toContain('ao.');
    expect(text).not.toMatch(/actor_ok|\bactor\b|key_tpl/);
  });

  it('assertActorOnce refuses a statement with two actor joins', () => {
    const once = `WITH ${p.ctes} SELECT 1 FROM ${p.rows}passes x WHERE ${p.tenant('x', 'passes')}`;
    expect(() => assertActorOnce(once)).not.toThrow();
    expect(() => assertActorOnce(`${once} AND EXISTS (SELECT 1 FROM actor_ok)`)).toThrow(
      /SQL_ACTOR_REUSE|joins actor_ok once/,
    );
  });
});

describe('the anchored statements compile on D1 at their widest', () => {
  const NOW = 1_700_000_000_000;
  const platform = (named: string | undefined) =>
    apiKeyReadAuthority({ keyId: 'depth-key', orgId: null }, named, NOW);

  it('staff activity with every filter reads one absent-actor row on an org key', async () => {
    const rows = await readStaffActivity(
      env.DB,
      apiKeyReadAuthority({ keyId: 'depth-key', orgId: 'org-depth' }, undefined, NOW),
      ['America/Los_Angeles', 'UTC', 'Asia/Tokyo'],
      NOW,
      {
        q: 'a%_b',
        limit: 200,
        staffId: 'staff-depth',
        cursor: { disabled: true, name: 'n', id: 'i' },
      },
      'America/Los_Angeles',
    );
    expect(rows.map((r) => [r.auth_ok, r.m_id])).toEqual([[0, null]]);
  });

  it.each([undefined, 'org-depth'])(
    'the named-platform authorized statement runs for %s',
    async (named) => {
      const { results } = await scanAuthorizedStmt(env.DB, platform(named)).all();
      expect(results).toEqual([{ authorized: 0 }]);
    },
  );
});
