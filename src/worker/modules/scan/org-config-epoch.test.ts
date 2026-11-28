// An org's config_revision (name, slug, branding, settings) is not door authority: a rename before
// or during a scan never fails it. Its access_revision (status) still does (authority-epochs.md, R8).
import { beforeAll, describe, expect, it } from 'vitest';
import { type ScanOutcome, ScanOutcomeSchema } from '../../../shared/contracts/scan.ts';
import { first, run } from '../../platform/db.ts';
import { RACE_GRANT_INSERT, RACE_LINEAGE } from './race-tags.ts';
import { codeOf, key, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let template: string;
beforeAll(async () => {
  kit = await setupScanKit();
  template = await kit.scanTemplate('Org config epoch', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    display: {
      v: 1,
      holder: '{{inputs.memberName}}',
      header: { subtitle: '{{history.lastScan.action}}' },
      panels: [
        {
          id: 'p_history',
          rows: [{ id: 'r_history', type: 'history', source: 'scans', show: ['action', 'where'] }],
        },
      ],
    },
  });
});

// `suspend` leaves the org suspended (a door write checks org status live at its commit);
// `suspend-restore` is an access_revision A-B-A, which the read fences see.
type Change = 'rename' | 'suspend' | 'suspend-restore';
// The door's commit batch (its write grant), after every preflight read of the request.
const COMMIT = RACE_GRANT_INSERT;

async function change(db: D1Database, kind: Change) {
  if (kind === 'rename')
    await run(db, "UPDATE orgs SET name = name || ' (renamed)' WHERE id = ?", [kit.org.id]);
  else
    for (const status of kind === 'suspend' ? ['suspended'] : ['suspended', 'active'])
      await run(db, 'UPDATE orgs SET status = ? WHERE id = ?', [status, kit.org.id]);
}

const restore = () =>
  run(kit.env.DB, "UPDATE orgs SET status = 'active' WHERE id = ?", [kit.org.id]);

/** Apply `kind` once, just before the first batch carrying `tag`, after the request's reads. */
async function racing(tag: string, kind: Change, work: () => Promise<Response>) {
  const real = kit.env.DB;
  const marked = new WeakSet<D1PreparedStatement>();
  let raced = false;
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          const prepared = target.prepare(sql);
          if (!sql.includes(tag)) return prepared;
          return new Proxy(prepared, {
            get(statement, member) {
              if (member === 'bind')
                return (...params: unknown[]) => {
                  const bound = statement.bind(...params);
                  marked.add(bound);
                  return bound;
                };
              const value = Reflect.get(statement, member, statement);
              return typeof value === 'function' ? value.bind(statement) : value;
            },
          });
        };
      if (prop === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (!raced && statements.some((statement) => marked.has(statement))) {
            raced = true;
            await change(target, kind);
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.assign(kit.env, { DB: db });
  try {
    const response = await work();
    expect(raced, `no batch carried ${tag}`).toBe(true);
    return response;
  } finally {
    Object.assign(kit.env, { DB: real });
  }
}

async function outcome(response: Response): Promise<ScanOutcome> {
  expect(response.status, await response.clone().text()).toBe(200);
  return ScanOutcomeSchema.parse(await response.json());
}

async function scanning(name: string, settings: Record<string, unknown> = {}) {
  const scanner = await kit.scanner({ templateIds: [template], settings });
  const pass = await kit.scanPass(template, { memberName: name });
  const post = (path: string, extra: Record<string, unknown> = {}) =>
    kit.post(scanner.headers, path, {
      idempotencyKey: key(),
      input: codeOf(pass),
      clientTs: kit.clock.now(),
      ...extra,
    });
  const act = (extra: Record<string, unknown> = {}) =>
    post('/actions', { actionId: 'check_in', ...extra });
  return { pass, act, read: () => post('/resolve') };
}

/** A held heads-up that a manager may approve, and that approval as a request. */
async function held(name: string) {
  const manager = await kit.staff('manager');
  const s = await scanning(name, { letInAgain: 'manager' });
  expect(await outcome(await s.act())).toMatchObject({ kind: 'ok' });
  const heads = await outcome(await s.act());
  expect(heads).toMatchObject({ kind: 'heads_up', reason: 'already_done', overridable: true });
  const approval = { staffId: manager.id, pin: manager.pin };
  return { ...s, approve: () => s.act({ overrideOf: heads.scanId, approval }) };
}

/** Recorded scans and ledger events for a pass, by outcome and kind. */
async function recorded(passId: string) {
  const scans = await first<{ ok: number; refused: number }>(
    kit.env.DB,
    `SELECT sum(outcome = 'ok') AS ok, sum(outcome = 'refused' AND reason = 'voided') AS refused
     FROM scans WHERE pass_id = ? AND state = 'done'`,
    [passId],
  );
  const events = await first<{ rejected: number }>(
    kit.env.DB,
    "SELECT count(*) AS rejected FROM pass_events WHERE pass_id = ? AND kind = 'scan.rejected'",
    [passId],
  );
  return { ok: scans?.ok ?? 0, refused: scans?.refused ?? 0, rejected: events?.rejected ?? 0 };
}

/** A door write whose org is suspended at its commit is refused and records nothing. */
async function denied(response: Response) {
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: 'ORG_ACCESS_CHANGED' });
}

describe('org config epoch at the door', () => {
  it('approves a held scan across an org rename; a suspension in between refuses it', async () => {
    const before = await held('Held before');
    await change(kit.env.DB, 'rename');
    expect(await outcome(await before.approve())).toMatchObject({ kind: 'ok' });
    const during = await held('Held during');
    const approved = await racing(COMMIT, 'rename', during.approve);
    expect(await outcome(approved)).toMatchObject({ kind: 'ok', scanId: expect.any(String) });
    expect(await recorded(during.pass.id)).toMatchObject({ ok: 2 });
    const suspended = await held('Held suspended');
    try {
      await denied(await racing(COMMIT, 'suspend', suspended.approve));
    } finally {
      await restore();
    }
    expect(await recorded(suspended.pass.id)).toMatchObject({ ok: 1 });
  });

  it('keeps card history when an org rename races the card read, and when an access A-B-A does', async () => {
    // A scanner's principal binds its credential, not the org's access revision: it is refused only
    // while the org is suspended, so a suspend and restore between two reads is not seen.
    for (const kind of ['rename', 'suspend-restore'] as const) {
      const s = await scanning(`History ${kind}`);
      const done = await outcome(await s.act());
      const read = await outcome(await racing(RACE_LINEAGE, kind, s.read));
      expect(read.kind).toBe('ready');
      expect(read.card?.lastScans.map((row) => row.scanId)).toEqual([done.scanId]);
      // The display's scan history (header and panel) is read from the same proofs.
      const display = read.card?.display;
      expect(display?.header.meta).toBe('Check in');
      expect(JSON.stringify(display?.panels)).toContain('"label":"Check in"');
    }
  });

  it('records a refused scan when an org rename races it; a suspension does not', async () => {
    for (const kind of ['rename', 'suspend'] as const) {
      const s = await scanning(`Refused ${kind}`);
      await run(kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [s.pass.id]);
      const response = await racing(COMMIT, kind, () => s.act());
      if (kind === 'suspend') {
        try {
          await denied(response);
        } finally {
          await restore();
        }
        expect(await recorded(s.pass.id)).toEqual({ ok: 0, refused: 0, rejected: 0 });
        continue;
      }
      expect(await outcome(response)).toMatchObject({ kind: 'refused', reason: 'voided' });
      expect(await recorded(s.pass.id)).toEqual({ ok: 0, refused: 1, rejected: 1 });
    }
  });
});
