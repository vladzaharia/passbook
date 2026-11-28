// choose, answer and stop show their display from a batch that runs after the grant's commit: the
// grant bound the actor and pass, that batch holds only the pass lineage. A pass that moves in the
// gap shows no history (and no counts); an unchanged pass shows it (positive control).

import { beforeAll, describe, expect, it } from 'vitest';
import { stagePendingCredentialTransfer } from '../../../../test/helpers/credential-transfer.ts';
import { type ScanOutcome, ScanOutcomeSchema } from '../../../shared/contracts/scan.ts';
import { run } from '../../platform/db.ts';
import { RACE_LINEAGE } from './race-tags.ts';
import { codeOf, key, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let template: string;
beforeAll(async () => {
  kit = await setupScanKit();
  template = await kit.scanTemplate('Post-commit history', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    flags: [{ input: 'tier', label: 'Review', equals: ['overdue'], stop: true }],
    display: {
      v: 1,
      header: { title: 'Welcome' },
      variants: [
        {
          id: 'returning',
          name: 'Returning',
          when: { path: 'history.visits.total', gte: 1 },
          header: { title: 'Returning member' },
        },
      ],
      panels: [
        { id: 'p', rows: [{ id: 'r', type: 'history', source: 'scans', show: ['action'] }] },
      ],
    },
  });
});

type Flow = 'choose' | 'answer' | 'stop';
type Gap = 'lifecycle moved' | 'credential transfer pending' | 'none';

/** Apply `gap` once, just before the first batch that carries the lineage check (after the commit). */
async function withGap(gap: Gap, work: () => Promise<Response>): Promise<Response> {
  const real = kit.env.DB;
  const marked = new WeakSet<D1PreparedStatement>();
  let raced = false;
  let passId = '';
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          const prepared = target.prepare(sql);
          if (!sql.includes(RACE_LINEAGE)) return prepared;
          return new Proxy(prepared, {
            get(statement, member) {
              if (member === 'bind')
                return (...params: unknown[]) => {
                  passId = String(params[0]);
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
            if (gap === 'lifecycle moved')
              await run(
                target,
                'UPDATE passes SET lifecycle_generation=lifecycle_generation+1 WHERE id=?',
                [passId],
              );
            else if (gap === 'credential transfer pending')
              await stagePendingCredentialTransfer(target, passId, {
                id: key(),
                token: key(),
                now: kit.clock.now(),
                targetHolderEmail: 'next@example.test',
              });
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
    expect(raced, 'no post-commit batch carried the lineage check').toBe(true);
    return response;
  } finally {
    Object.assign(kit.env, { DB: real });
  }
}

/** A pass with one earlier check-in, and the request that takes `flow`'s post-commit path. */
async function scenario(flow: Flow) {
  const settings =
    flow === 'choose' ? { flow: 'choose' } : flow === 'answer' ? { letInAgain: 'manager' } : {};
  const scanner = await kit.scanner({ templateIds: [template], settings });
  const pass = await kit.scanPass(template, { memberName: `Post ${flow}` });
  const post = (extra: Record<string, unknown>) =>
    kit.post(scanner.headers, '/actions', {
      idempotencyKey: key(),
      input: codeOf(pass),
      clientTs: kit.clock.now(),
      ...extra,
    });
  // The earlier visit: an explicit check-in (the choose flow only asks when no action is named).
  const first = (await (await post({ actionId: 'check_in' })).json()) as ScanOutcome;
  expect(first.kind).toBe('ok');
  kit.clock.advance(1_000);
  if (flow === 'stop')
    await run(
      kit.env.DB,
      "UPDATE passes SET personalization=json_set(personalization,'$.tier','overdue') WHERE id=?",
      [pass.id],
    );
  return { pass, request: () => post({ actionId: 'auto' }) };
}

const EXPECTED = { choose: 'ready', answer: 'heads_up', stop: 'heads_up' } as const;

describe('post-commit display history', () => {
  it.each(['choose', 'answer', 'stop'] as const)(
    'the %s display shows the earlier visit when the pass did not move',
    async (flow) => {
      const s = await scenario(flow);
      const response = await withGap('none', s.request);
      expect(response.status).toBe(200);
      const outcome = ScanOutcomeSchema.parse(await response.json());
      expect(outcome.kind).toBe(EXPECTED[flow]);
      expect(JSON.stringify(outcome.display ?? outcome.card?.display)).toContain(
        '"variant":"returning"',
      );
    },
  );

  it.each([
    ['choose', 'lifecycle moved'],
    ['choose', 'credential transfer pending'],
    ['answer', 'lifecycle moved'],
    ['answer', 'credential transfer pending'],
    ['stop', 'lifecycle moved'],
    ['stop', 'credential transfer pending'],
  ] as const)(
    'the %s display shows no history when the pass has %s in the gap',
    async (flow, gap) => {
      const s = await scenario(flow);
      const response = await withGap(gap, s.request);
      // The commit stands; the answer is whatever the flow can still say without the history.
      const text = await response.text();
      expect(text).not.toContain('"variant":"returning"');
      expect(text).not.toContain('"visits"');
    },
  );
});
