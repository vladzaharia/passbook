// 0114 channel_apply_runs and channel_apply_marks: one pending and one running run per (org, mode, template),
// a one-way state machine, to_* set only when the run starts, a tenant fence on both tables, and marks that
// move only journaled_at and notice_at, once each.
import type { DatabaseSync } from 'node:sqlite';
import { beforeAll, describe, expect, it } from 'vitest';
import { epochWorld, rolledBack } from './wallet-instances-fixtures.ts';

let db: DatabaseSync;
beforeAll(() => {
  db = epochWorld();
  // A second template and live/test mode of org 1 for the key tests; org 2 has t-o2.
  db.exec(
    "INSERT INTO templates (id, org_id, slug, name, origin, created_at, updated_at) VALUES ('t2-o1', 'o1', 't2', 'T2', 'uploaded', 1, 1)",
  );
});
const run = (sql: string) => db.exec(sql);
const one = (sql: string) => ({ ...(db.prepare(sql).get() as Record<string, unknown>) });

const runSql = (over: Record<string, string> = {}) => {
  const v: Record<string, string> = {
    id: "'r1'",
    org_id: "'o1'",
    mode: "'live'",
    template_id: "'t-o1'",
    state: "'pending'",
    from_channels: "'{}'",
    from_revision: '0',
    due_at: '100',
    requested_by: "'u'",
    created_at: '1',
    updated_at: '1',
    ...over,
  };
  return `INSERT INTO channel_apply_runs (${Object.keys(v).join(', ')}) VALUES (${Object.values(v).join(', ')})`;
};
const toRunning = (id = 'r1') =>
  `UPDATE channel_apply_runs SET state = 'running', to_channels = '{}', to_revision = 1, started_at = 2 WHERE id = '${id}'`;
const markSql = (run = 'r1', pass = 'p1') =>
  `INSERT INTO channel_apply_marks (run_id, pass_id, events) VALUES ('${run}', '${pass}', '[]')`;
const upd = (set: string, id = 'r1') => `UPDATE channel_apply_runs SET ${set} WHERE id = '${id}'`;

describe('channel_apply_runs', () => {
  it('allows one pending and one running per (org, mode, template), and only that key', () => {
    rolledBack(db, () => {
      run(runSql());
      expect(() => run(runSql({ id: "'r2'" }))).toThrow(/UNIQUE/);
      const others: Record<string, string>[] = [
        { mode: "'test'" },
        { template_id: "'t2-o1'" },
        { org_id: "'o2'", template_id: "'t-o2'" },
      ];
      for (const [i, other] of others.entries()) run(runSql({ id: `'x${i}'`, ...other }));
      run(toRunning());
      run(runSql({ id: "'r2'" }));
      run(runSql({ id: "'r3'", org_id: "'o2'", template_id: "'t-o2'", mode: "'test'" }));
      run(toRunning('r3'));
      run(upd("state = 'done'", 'r3'));
      expect(() => run(toRunning('r2'))).toThrow(/UNIQUE/);
    });
  });

  it('refuses a template of another org, bad json and a state that disagrees with to_channels', () => {
    rolledBack(db, () => {
      expect(() => run(runSql({ template_id: "'t-o2'" }))).toThrow(/tenant mismatch/);
      expect(() => run(runSql({ org_id: "'o2'" }))).toThrow(/tenant mismatch/);
      expect(() => run(runSql({ from_channels: "'{'" }))).toThrow(/CHECK/);
      expect(() => run(runSql({ to_channels: "'{}'" }))).toThrow(/CHECK/);
      expect(() => run(runSql({ state: "'running'" }))).toThrow(/start pending/);
      expect(() => run(runSql({ state: "'done'" }))).toThrow(/start pending/);
      expect(() => run(runSql({ state: "'bogus'" }))).toThrow(/start pending|CHECK/);
    });
  });

  it('moves pending to running, dropped or failed, and running to done or failed', () => {
    for (const to of ['dropped', 'failed']) {
      rolledBack(db, () => {
        run(runSql());
        run(upd(`state = '${to}'`));
        expect(one("SELECT state FROM channel_apply_runs WHERE id = 'r1'").state).toBe(to);
      });
    }
    for (const to of ['done', 'failed']) {
      rolledBack(db, () => {
        run(runSql());
        run(toRunning());
        run(upd(`state = '${to}', finished_at = 3`));
        expect(one("SELECT state FROM channel_apply_runs WHERE id = 'r1'").state).toBe(to);
      });
    }
  });

  it('refuses every other move and any move out of a final state', () => {
    rolledBack(db, () => {
      run(runSql());
      expect(() => run(upd("state = 'done'"))).toThrow(/invalid channel apply run transition/);
      run(toRunning());
      expect(() => run(upd("state = 'pending'"))).toThrow(/invalid channel apply run transition/);
      expect(() => run(upd("state = 'dropped'"))).toThrow(/invalid channel apply run transition/);
      run(upd("state = 'done'"));
      for (const to of ['pending', 'running', 'failed'])
        expect(() => run(upd(`state = '${to}'`))).toThrow(/invalid channel apply run transition/);
    });
  });

  it('sets to_* only when the run starts, and keeps the key immutable', () => {
    rolledBack(db, () => {
      run(runSql());
      expect(() => run(upd("to_channels = '{}'"))).toThrow(/CHECK|invalid channel apply run/);
      expect(() => run(upd("state = 'failed', to_channels = '{}', to_revision = 1"))).toThrow(
        /invalid channel apply run transition/,
      );
      run(toRunning());
      expect(() => run(upd('to_channels = \'{"apple":true}\''))).toThrow(
        /invalid channel apply run transition/,
      );
      run(upd("cursor = 'p9', updated_at = 9, counts = '{\"n\":1}'"));
      for (const set of [
        "org_id = 'o2'",
        "mode = 'test'",
        "template_id = 't2-o1'",
        'from_channels = \'{"a":1}\'',
        'from_revision = 5',
        "requested_by = 'v'",
        "id = 'r9'",
      ])
        expect(() => run(upd(set))).toThrow(/key is immutable/);
    });
  });
});

describe('channel_apply_runs lifecycle rules', () => {
  it('joins saves into replace_channels only while pending', () => {
    rolledBack(db, () => {
      run(runSql());
      run(upd('replace_channels = \'["google"]\', due_at = 200'));
      run(toRunning());
      expect(() => run(upd('replace_channels = \'["samsung"]\''))).toThrow(
        /invalid channel apply run/,
      );
    });
  });

  it('freezes a finished run', () => {
    for (const final of ['done', 'failed']) {
      rolledBack(db, () => {
        run(runSql());
        run(toRunning());
        run(upd(`state = '${final}', finished_at = 3, counts = '{"n":1}'`));
        for (const set of [
          'counts = \'{"n":2}\'',
          "cursor = 'p'",
          "error_code = 'X'",
          'finished_at = 4',
          'updated_at = 9',
        ])
          expect(() => run(upd(set)), set).toThrow(/invalid channel apply run transition/);
      });
    }
  });
});

describe('channel_apply_marks', () => {
  it('takes only passes of the run org, mode and template', () => {
    rolledBack(db, () => {
      run(runSql());
      run(markSql());
      expect(() => run(markSql())).toThrow(/UNIQUE/);
      expect(() => run(markSql('r1', 'p2'))).toThrow(/tenant mismatch/);
      run(runSql({ id: "'rt'", mode: "'test'" }));
      expect(() => run(markSql('rt', 'p1'))).toThrow(/tenant mismatch/);
      run(runSql({ id: "'r2t'", template_id: "'t2-o1'" }));
      expect(() => run(markSql('r2t', 'p1'))).toThrow(/tenant mismatch/);
      expect(() => run(markSql('missing', 'p1'))).toThrow(/tenant mismatch/);
      expect(() =>
        run("INSERT INTO channel_apply_marks (run_id, pass_id, events) VALUES ('r1', 'p9', 'x')"),
      ).toThrow(/CHECK|tenant|FOREIGN/);
    });
  });

  it('moves journaled_at and notice_at once each and nothing else', () => {
    rolledBack(db, () => {
      run(runSql());
      run(markSql());
      const upd = (set: string) =>
        run(`UPDATE channel_apply_marks SET ${set} WHERE run_id = 'r1' AND pass_id = 'p1'`);
      upd('journaled_at = 5');
      upd('journaled_at = 5');
      expect(() => upd('journaled_at = 6')).toThrow(/write-once/);
      expect(() => upd('journaled_at = NULL')).toThrow(/write-once/);
      upd('notice_at = 7');
      expect(() => upd('notice_at = 8')).toThrow(/write-once/);
      for (const set of ["events = '[1]'", "pass_id = 'p2'", "run_id = 'r9'"])
        expect(() => upd(set)).toThrow(/write-once/);
    });
  });

  it('goes with its run', () => {
    rolledBack(db, () => {
      run(runSql());
      run(markSql());
      run("DELETE FROM channel_apply_runs WHERE id = 'r1'");
      expect(one('SELECT count(*) AS n FROM channel_apply_marks').n).toBe(0);
    });
  });
});
