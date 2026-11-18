import { unzipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { accessTemplate } from './access-test-fixtures.ts';
import {
  act,
  kit,
  MINUTE,
  out,
  reviseReplayTemplate,
  setupActionFixture,
} from './act-test-fixtures.ts';
import { scanAt, trackedZone, zoneDoor } from './occupancy-scan-test-fixtures.ts';
import { codeOf, key } from './test-kit.ts';

const CHECK_IN = { id: 'check_in', label: 'Check in', kind: 'check_in' } as const;
const ADD = {
  id: 'add',
  label: 'Add',
  kind: 'add',
  input: 'balance',
  repeat: 'always',
  amount: 1,
} as const;
const term = (startOn: 'first-scan' | 'issue') => [
  {
    use: 'term',
    version: 1,
    config: { start: 'startsAt', startOn, unit: 'months' as const, length: 12 },
  },
];

let scanTpl: string;
let valueTpl: string;
let issueTpl: string;

const desk = (id: string) =>
  kit.scanner({ templateIds: [id], settings: { roleWithoutSignIn: 'desk' } });

async function termTemplate(name: string, actions: unknown[], startOn: 'first-scan' | 'issue') {
  const id = await kit.scanTemplate(name, { actions } as never);
  await reviseReplayTemplate(id, (m) => {
    m.behaviors = term(startOn);
  });
  return id;
}

beforeAll(async () => {
  await setupActionFixture();
  scanTpl = await termTemplate('Gym term', [CHECK_IN, ADD], 'first-scan');
  valueTpl = await termTemplate('Value term', [ADD], 'first-scan');
  issueTpl = await termTemplate('Issue term', [CHECK_IN, ADD], 'issue');
});

async function stored(passId: string) {
  const pass = await getPass(kit.env.DB, passId);
  if (!pass) throw new Error('missing pass');
  const object = await kit.env.BUCKET.get(pass.objectKey);
  const files = unzipSync(new Uint8Array((await object?.arrayBuffer()) ?? new ArrayBuffer(0)));
  const json = JSON.parse(new TextDecoder().decode(files['pass.json'])) as {
    expirationDate?: string;
  };
  return { start: pass.personalization.startsAt, expires: json.expirationDate, pass };
}

/** The stamp runs after the response: wait for the pass to show it. */
async function stamped(passId: string) {
  for (let i = 0; i < 100; i++) {
    const s = await stored(passId);
    if (typeof s.start === 'string') return s;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('not stamped');
}
const settle = () => new Promise((r) => setTimeout(r, 300));
const plusYear = (at: number) => {
  const end = new Date(at);
  end.setUTCFullYear(end.getUTCFullYear() + 1);
  return end.toISOString().replace('.000Z', 'Z');
};

describe('term: first scan', () => {
  it('stamps the start at the first scan and re-signs with the end', async () => {
    const s = await kit.scanner({ templateIds: [scanTpl] });
    const pass = await kit.scanPass(scanTpl);
    expect((await stored(pass.id)).expires).toBeUndefined();
    const o = await out(await act(s.headers, codeOf(pass), { actionId: 'check_in' }));
    expect(o.kind).toBe('ok');
    const row = await first<{ at: number }>(kit.env.DB, 'SELECT at FROM scans WHERE id = ?', [
      o.scanId ?? '',
    ]);
    const after = await stamped(pass.id);
    expect(after.start).toBe(new Date(row?.at ?? 0).toISOString());
    expect((await stored(pass.id)).expires).toBe(plusYear(row?.at ?? 0));
  });

  it('leaves the start where it is on a second scan, a retry and a heads-up', async () => {
    const a = await kit.scanner({ templateIds: [scanTpl] });
    const b = await kit.scanner({ templateIds: [scanTpl] });
    const pass = await kit.scanPass(scanTpl);
    const request = { idempotencyKey: key(), actionId: 'check_in' };
    expect((await out(await act(a.headers, codeOf(pass), request))).kind).toBe('ok');
    const before = await stamped(pass.id);
    kit.clock.advance(5 * MINUTE);
    await act(a.headers, codeOf(pass), request);
    const second = await out(await act(b.headers, codeOf(pass), { actionId: 'check_in' }));
    expect(second.kind).toBe('heads_up');
    await settle();
    const after = await stored(pass.id);
    expect(after.start).toBe(before.start);
    expect(after.expires).toBe(before.expires);
    expect(after.pass.version).toBe(before.pass.version);
  });

  it('stamps from a value action too', async () => {
    const s = await desk(valueTpl);
    const pass = await kit.scanPass(valueTpl, { balance: 1 });
    const o = await out(await act(s.headers, codeOf(pass), { actionId: 'add' }));
    expect(o.kind).toBe('ok');
    const after = await stamped(pass.id);
    expect((await stored(pass.id)).expires).toEqual(expect.any(String));
    expect(after.pass.personalization.balance).toBe(2);
  });

  it('does not write an input a connection owns', async () => {
    const s = await kit.scanner({ templateIds: [scanTpl] });
    const pass = await kit.scanPass(scanTpl);
    await run(kit.env.DB, 'UPDATE passes SET field_sources = ? WHERE id = ?', [
      JSON.stringify({ startsAt: 'connection' }),
      pass.id,
    ]);
    await act(s.headers, codeOf(pass), { actionId: 'check_in' });
    await settle();
    expect((await stored(pass.id)).start).toBeUndefined();
  });

  it('undo takes the start back when it is the pass only scan', async () => {
    const s = await kit.scanner({ templateIds: [scanTpl] });
    const pass = await kit.scanPass(scanTpl);
    const o = await out(await act(s.headers, codeOf(pass), { actionId: 'check_in' }));
    await stamped(pass.id);
    const res = await kit.post(s.headers, `/scans/${o.scanId}/undo`, { idempotencyKey: key() });
    expect(res.status).toBe(200);
    for (let i = 0; i < 100 && typeof (await stored(pass.id)).start === 'string'; i++)
      await new Promise((r) => setTimeout(r, 20));
    const after = await stored(pass.id);
    expect(after.start).toBeUndefined();
    expect(after.expires).toBeUndefined();
    // The rescan starts it again.
    kit.clock.advance(MINUTE);
    await act(s.headers, codeOf(pass), { actionId: 'check_in' });
    expect(typeof (await stamped(pass.id)).start).toBe('string');
  });

  it('undo keeps the start when another scan of the pass stands', async () => {
    const s = await desk(scanTpl);
    const pass = await kit.scanPass(scanTpl);
    const o = await out(await act(s.headers, codeOf(pass), { actionId: 'check_in' }));
    const before = await stamped(pass.id);
    kit.clock.advance(MINUTE);
    expect((await out(await act(s.headers, codeOf(pass), { actionId: 'add' }))).kind).toBe('ok');
    const res = await kit.post(s.headers, `/scans/${o.scanId}/undo`, { idempotencyKey: key() });
    expect(res.status).toBe(200);
    await settle();
    expect((await stored(pass.id)).start).toBe(before.start);
  });
});

describe('term: deferred stamp', () => {
  it('hands the publish to waitUntil, not to the scan response', async () => {
    const s = await kit.scanner({ templateIds: [scanTpl] });
    const pass = await kit.scanPass(scanTpl);
    const deferred: Promise<unknown>[] = [];
    const executionCtx = {
      waitUntil: (p: Promise<unknown>) => void deferred.push(p),
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;
    const res = await kit.post(
      s.headers,
      '/actions',
      {
        idempotencyKey: key(),
        input: codeOf(pass),
        clientTs: kit.clock.now(),
        actionId: 'check_in',
      },
      executionCtx,
    );
    expect((await out(res)).kind).toBe('ok');
    // The stamp's publish went through waitUntil, so the response did not wait for it.
    expect(deferred.length).toBeGreaterThan(0);
    await Promise.all(deferred);
    expect(typeof (await stored(pass.id)).start).toBe('string');
  });
});

describe('term: exits and older passes', () => {
  it('an exit does not start the term; the next entry does', async () => {
    const tpl = await accessTemplate();
    await reviseReplayTemplate(tpl, (m) => {
      (m.inputs.properties as Record<string, unknown>).startsAt = {
        type: 'string',
        format: 'date-time',
      };
      m.behaviors = term('first-scan');
    });
    const gym = await trackedZone({ occupancy: 'track' });
    const way = await zoneDoor(tpl, [gym]);
    const exit = await zoneDoor(tpl, [gym], 'out');
    const pass = await kit.scanPass(tpl, { plan: 'gold' });
    expect((await scanAt(way, pass, 'in')).occupancy?.direction).toBe('in');
    await stamped(pass.id);
    // Forget the start, as if the entry had not stamped it, then leave.
    await run(
      kit.env.DB,
      `UPDATE passes SET personalization = json_remove(personalization, '$.startsAt'),
         field_sources = json_remove(field_sources, '$.startsAt') WHERE id = ?`,
      [pass.id],
    );
    kit.clock.advance(MINUTE);
    const left = await scanAt(exit, pass);
    expect(left.occupancy?.direction).toBe('out');
    await settle();
    expect((await stored(pass.id)).start).toBeUndefined();
    kit.clock.advance(MINUTE);
    expect((await scanAt(way, pass, 'in')).occupancy?.direction).toBe('in');
    expect(typeof (await stamped(pass.id)).start).toBe('string');
  });

  it('stamps an older pass once at its first publish, then keeps it', async () => {
    const s = await desk(issueTpl);
    const pass = await kit.scanPass(issueTpl);
    // An older pass: built before the term existed, so it has no start input.
    await run(
      kit.env.DB,
      `UPDATE passes SET personalization = json_remove(personalization, '$.startsAt'),
         field_sources = json_remove(field_sources, '$.startsAt') WHERE id = ?`,
      [pass.id],
    );
    expect((await stored(pass.id)).start).toBeUndefined();
    const stampedAt = kit.clock.now() + MINUTE;
    kit.clock.advance(MINUTE);
    expect((await out(await act(s.headers, codeOf(pass), { actionId: 'add' }))).kind).toBe('ok');
    const first1 = await stored(pass.id);
    expect(first1.start).toBe(new Date(stampedAt).toISOString());
    expect(first1.expires).toBe(plusYear(stampedAt));
    kit.clock.advance(5 * MINUTE);
    expect((await out(await act(s.headers, codeOf(pass), { actionId: 'add' }))).kind).toBe('ok');
    const second = await stored(pass.id);
    expect(second.start).toBe(first1.start);
    expect(second.expires).toBe(first1.expires);
  });
});

describe('term: issue', () => {
  it('stamps the start once at create and never moves it on a rebuild', async () => {
    const pass = await kit.scanPass(issueTpl);
    const created = await stored(pass.id);
    expect(created.start).toBe(new Date(kit.clock.now()).toISOString());
    expect(created.expires).toBe(plusYear(kit.clock.now()));
    kit.clock.advance(90 * 24 * 60 * MINUTE);
    // A value action republishes the pass: the rebuild keeps the stamped start.
    const s = await desk(issueTpl);
    const o = await out(await act(s.headers, codeOf(pass), { actionId: 'add' }));
    expect(o.kind).toBe('ok');
    const again = await stored(pass.id);
    expect(again.start).toBe(created.start);
    expect(again.expires).toBe(created.expires);
    expect(again.pass.version).toBe(created.pass.version + 1);
  });
});
