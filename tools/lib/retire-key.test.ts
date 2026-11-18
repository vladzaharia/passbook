import { describe, expect, it } from 'vitest';
import { ENVELOPE_TABLES } from '../../src/worker/modules/keys/rewrap-tables.ts';
import { type RetireDeps, retireChecks, rowsOf } from './retire-key.ts';

const NOW = Date.UTC(2026, 10, 20);
const HOUR = 3_600_000;

interface World {
  secrets: string[];
  done: object | null;
  roots: object | null;
  /** The ring the deployed Worker recorded; defaults to what the secret list says. */
  ring?: object | null;
  /** Replace the answer of the count and PIN queries. */
  countsRaw?: unknown;
  staffRaw?: unknown;
  /** Rows per table still on the KEK, and staff PINs on the root. */
  counts: Record<string, number>;
  staff: number;
  vars: RetireDeps['vars'];
}

const world = (patch: Partial<World> = {}): World => ({
  secrets: ['KEK_V1', 'KEK_V2', 'MAC_ROOT_V1', 'TURNSTILE_SECRET'],
  done: { stamp: '1>2', unreadable: 0, at: NOW - HOUR, startedAt: NOW - 30 * HOUR, remaining: {} },
  roots: { '1': 'match', at: NOW - 60_000 },
  counts: {},
  staff: 0,
  vars: {},
  ...patch,
});

function deps(w: World): RetireDeps & { sql: string[] } {
  const sql: string[] = [];
  const out = (results: unknown[]) => JSON.stringify([{ results, success: true }]);
  const names = w.secrets;
  const nums = (prefix: string) =>
    names.flatMap((n) => (n.startsWith(`${prefix}_V`) ? [Number(n.slice(prefix.length + 2))] : []));
  const ring =
    w.ring === undefined
      ? {
          at: NOW - 30_000,
          pin: Number(w.vars.MAC_KEY_VERSION) || null,
          previous: Number(w.vars.MAC_KEY_VERSION_PREVIOUS) || null,
          kek: nums('KEK'),
          macRoot: nums('MAC_ROOT'),
        }
      : w.ring;
  return {
    sql,
    secretList: () => JSON.stringify(w.secrets.map((name) => ({ name, type: 'secret_text' }))),
    query(text) {
      sql.push(text);
      if (text.includes('FROM settings'))
        return out(
          [
            w.done && { key: 'keys.rewrapDone', value: JSON.stringify(w.done) },
            w.roots && { key: 'keys.macRoots', value: JSON.stringify(w.roots) },
            ring && { key: 'keys.ring', value: JSON.stringify(ring) },
          ].filter(Boolean),
        );
      if (text.includes('FROM scan_staff'))
        return w.staffRaw === undefined ? out([{ n: w.staff }]) : (w.staffRaw as string);
      return w.countsRaw === undefined
        ? out(ENVELOPE_TABLES.map((t) => ({ t, n: w.counts[t] ?? 0 })))
        : (w.countsRaw as string);
    },
    vars: w.vars,
    now: () => NOW,
  };
}

const check = (n: number, patch: Partial<World> = {}) => retireChecks(n, deps(world(patch)));

describe('keys:retire checks', () => {
  it('passes when the rewrap is done, the root is verified and nothing uses the KEK', () => {
    expect(check(1)).toEqual([]);
  });

  it('counts every table exactly, not only what the cron said', () => {
    const d = deps(world());
    retireChecks(1, d);
    const counts = d.sql.find((s) => s.includes('UNION ALL')) ?? '';
    for (const table of ENVELOPE_TABLES) expect(counts).toContain(table);
    expect(counts).toContain("html GLOB 'enc1:1.*'");
    expect(check(1, { counts: { pass_token_seals: 3, captured_emails: 1 } })).toEqual([
      '3 rows in pass_token_seals still use KEK_V1.',
      '1 rows in captured_emails still use KEK_V1.',
    ]);
  });

  it('refuses before the rewrap is done, with unreadable rows, and inside the cursor window', () => {
    expect(check(1, { done: null })[0]).toContain('has not finished');
    expect(
      check(1, { done: { stamp: '1,2>3', unreadable: 0, startedAt: 0, remaining: {} } })[0],
    ).toContain('has not finished');
    expect(
      check(1, {
        done: {
          stamp: '1>2',
          unreadable: 2,
          at: NOW,
          startedAt: NOW - 30 * HOUR,
          remaining: { '1': 2 },
        },
      }),
    ).toEqual([
      'The rewrap left 2 rows it could not open.',
      '2 rows still used KEK_V1 when the sweep ended.',
    ]);
    expect(
      check(1, {
        done: { stamp: '1>2', unreadable: 0, at: NOW, startedAt: NOW - 2 * HOUR, remaining: {} },
      }),
    ).toEqual(['Wait 24 hours from the first rewrap run: console cursors live that long.']);
  });

  it('refuses a version that is not an older KEK in the live secret list', () => {
    expect(check(2)[0]).toContain('not an older KEK');
    expect(check(3)[0]).toContain('not an older KEK');
    expect(check(1, { secrets: ['KEK_V2', 'MAC_ROOT_V1'] })[0]).toContain('not an older KEK');
  });

  it('needs the MAC root of a version whose keys are in use, and a fresh match', () => {
    expect(check(1, { secrets: ['KEK_V1', 'KEK_V2'] })).toEqual([
      'MAC_ROOT_V1 is not set: V1 is a MAC root in use.',
    ]);
    expect(check(1, { roots: { '1': 'mismatch', at: NOW } })).toEqual([
      'MAC_ROOT_V1 is not verified against KEK_V1.',
    ]);
    expect(check(1, { roots: null })).toEqual(['MAC_ROOT_V1 is not verified against KEK_V1.']);
    expect(check(1, { roots: { '1': 'match', at: NOW - 20 * 60_000 } })).toEqual([
      'MAC_ROOT_V1 is not verified against KEK_V1.',
      'keys.macRoots is older than 15 minutes: the cron has not checked MAC_ROOT recently.',
    ]);
  });

  it('retires a version that is no root in use without a MAC root', () => {
    const secrets = ['KEK_V1', 'KEK_V2', 'KEK_V3', 'MAC_ROOT_V1'];
    const done = {
      stamp: '1,2>3',
      unreadable: 0,
      at: NOW,
      startedAt: NOW - 30 * HOUR,
      remaining: {},
    };
    expect(check(2, { secrets, done })).toEqual([]);
    // V1 is still the oldest root, V2 is pinned.
    expect(check(2, { secrets, done, vars: { MAC_KEY_VERSION: '2' } })).toEqual([
      'MAC_ROOT_V2 is not set: V2 is a MAC root in use.',
    ]);
  });

  it('refuses while MAC_KEY_VERSION_PREVIOUS names it', () => {
    expect(check(1, { vars: { MAC_KEY_VERSION: '2', MAC_KEY_VERSION_PREVIOUS: '1' } })).toEqual([
      'MAC_KEY_VERSION_PREVIOUS is 1: finish the MAC key rotation first.',
    ]);
  });

  it('refuses staff PINs on the version unless its MAC root is set', () => {
    expect(check(1, { staff: 4 })).toEqual([]);
    const secrets = ['KEK_V1', 'KEK_V2', 'KEK_V3', 'MAC_ROOT_V1'];
    const done = {
      stamp: '1,2>3',
      unreadable: 0,
      at: NOW,
      startedAt: NOW - 30 * HOUR,
      remaining: {},
    };
    expect(check(2, { secrets, done, staff: 4 })).toEqual([
      '4 staff PINs are on root 2: reset them in Scanning.',
    ]);
  });

  it('judges the deployed Worker: a missing or stale record refuses', () => {
    expect(check(1, { ring: null })).toEqual([
      'keys.ring is missing: the cron has not recorded the deployed ring.',
    ]);
    const stale = { at: NOW - 16 * 60_000, pin: null, previous: null, kek: [1, 2], macRoot: [1] };
    expect(check(1, { ring: stale })).toEqual([
      'keys.ring is older than 15 minutes: the cron is not running on the latest deploy.',
    ]);
  });

  it('refuses when the local wrangler.jsonc disagrees with what the Worker runs', () => {
    const ring = { at: NOW - 1000, pin: 2, previous: 1, kek: [1, 2], macRoot: [1] };
    // Deployed pins previous = 1, the checkout does not: retiring 1 on the checkout's word would break links.
    expect(check(1, { ring, vars: { MAC_KEY_VERSION: '2' } })).toEqual([
      'wrangler.jsonc MAC_KEY_VERSION_PREVIOUS (unset) is not what the deployed Worker runs (1).',
    ]);
    expect(check(1, { ring, vars: { MAC_KEY_VERSION: 2, MAC_KEY_VERSION_PREVIOUS: '1' } })).toEqual(
      ['MAC_KEY_VERSION_PREVIOUS is 1: finish the MAC key rotation first.'],
    );
    // The checkout says nothing is pinned, the deployed Worker pins 2.
    expect(check(1, { ring: { ...ring, previous: null }, vars: {} })[0]).toContain(
      'MAC_KEY_VERSION (unset) is not what the deployed Worker runs (2)',
    );
  });

  it('uses the recorded pins, not the local ones, for what is in use', () => {
    const secrets = ['KEK_V1', 'KEK_V2', 'KEK_V3', 'MAC_ROOT_V1'];
    const done = {
      stamp: '1,2>3',
      unreadable: 0,
      at: NOW,
      startedAt: NOW - 30 * HOUR,
      remaining: {},
    };
    const ring = { at: NOW - 1000, pin: 2, previous: null, kek: [1, 2, 3], macRoot: [1] };
    expect(check(2, { secrets, done, ring, vars: { MAC_KEY_VERSION: '2' } })).toEqual([
      'MAC_ROOT_V2 is not set: V2 is a MAC root in use.',
    ]);
  });

  it('refuses when the secret list and the recorded ring differ', () => {
    expect(
      check(1, {
        ring: { at: NOW - 1000, pin: null, previous: null, kek: [1, 2, 3], macRoot: [1] },
      }),
    ).toEqual([
      'The secret list and the ring the Worker recorded differ: wait for the next cron run.',
    ]);
  });

  it('refuses a result of an unexpected shape or length', () => {
    const refused = ['A production query returned an unexpected result: nothing was checked.'];
    const row = (t: string, n: unknown) => ({ t, n });
    const ok = ENVELOPE_TABLES.map((t) => row(t, 0));
    const wrap = (results: unknown[]) => JSON.stringify([{ results }]);
    expect(check(1, { countsRaw: wrap(ok.slice(1)) })).toEqual(refused);
    expect(check(1, { countsRaw: wrap([...ok, row('extra', 0)]) })).toEqual(refused);
    expect(
      check(1, { countsRaw: wrap([row(ENVELOPE_TABLES[0] ?? '', 0), ...ok.slice(0, -1)]) }),
    ).toEqual(refused);
    expect(check(1, { countsRaw: wrap(ok.map((r, i) => (i === 3 ? row(r.t, '0') : r))) })).toEqual(
      refused,
    );
    expect(check(1, { countsRaw: wrap(ok.map((r, i) => (i === 3 ? row(r.t, -1) : r))) })).toEqual(
      refused,
    );
    expect(check(1, { countsRaw: wrap(ok.map((r, i) => (i === 3 ? row(r.t, null) : r))) })).toEqual(
      refused,
    );
    expect(check(1, { countsRaw: '[]' })).toEqual(refused);
    expect(check(1, { countsRaw: 'not json' })).toEqual(refused);
    expect(check(1, { countsRaw: '{"results":[]}' })).toEqual(refused);
    expect(check(1, { secrets: ['KEK_V1', 'KEK_V2'], staffRaw: wrap([]) })).toEqual(refused);
    expect(
      check(1, { secrets: ['KEK_V1', 'KEK_V2'], staffRaw: wrap([{ n: 0 }, { n: 0 }]) }),
    ).toEqual(refused);
    expect(check(1, { secrets: ['KEK_V1', 'KEK_V2'], staffRaw: wrap([{ n: '0' }]) })).toEqual(
      refused,
    );
    expect(check(1, { secrets: ['KEK_V1', 'KEK_V2'], staffRaw: wrap([{ m: 0 }]) })).toEqual(
      refused,
    );
  });

  it('reads wrangler output rows', () => {
    expect(rowsOf('[{"results":[{"a":1}]},{"results":[{"a":2}]}]')).toEqual([{ a: 1 }, { a: 2 }]);
    expect(() => rowsOf('{}')).toThrow();
    expect(() => rowsOf('[]')).toThrow();
  });
});
