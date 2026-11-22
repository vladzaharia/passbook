import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TEST_NOW } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { act, CHECK_IN, kit, setupActionFixture } from './act-test-fixtures.ts';
import { hashOf, LIST, rosterOf, ticketTemplate } from './offline-test-fixtures.ts';
import { codeOf } from './test-kit.ts';

beforeAll(setupActionFixture);
afterEach(() => kit.clock.set(TEST_NOW));

describe('the offline roster', () => {
  it('lists the session scope only, as hashes with a status and a state', async () => {
    const tpl = await ticketTemplate();
    const elsewhere = await ticketTemplate();
    const mine = await kit.scanPass(tpl);
    const theirs = await kit.scanPass(elsewhere);
    const door = await kit.scanner({ templateIds: [tpl], settings: LIST });

    const roster = await rosterOf(door.headers);
    const hashes = roster.entries.map((e) => e.h);
    expect(hashes).toContain(await hashOf(mine.scanCode ?? ''));
    expect(hashes).not.toContain(await hashOf(theirs.scanCode ?? ''));
    expect(roster.cursor).toBeNull();
    for (const entry of roster.entries)
      expect(Object.keys(entry).sort()).toEqual(['h', 'state', 'status']);
  });

  it('holds no name, id or code in the clear', async () => {
    const tpl = await ticketTemplate();
    const pass = await kit.scanPass(tpl, { memberName: 'Zinaida Voicu' });
    const door = await kit.scanner({ templateIds: [tpl], settings: LIST });
    const text = JSON.stringify(await rosterOf(door.headers));
    for (const secret of ['Zinaida', 'Voicu', pass.id, pass.scanCode ?? '', pass.authToken])
      expect(text).not.toContain(secret);
  });

  it('leaves the barcode message hash off, so a stolen door cannot brute-force member numbers', async () => {
    const tpl = await kit.scanTemplate(
      'Member',
      { actions: [CHECK_IN] },
      { barcode: '{{inputs.memberName}}' },
    );
    const pass = await kit.scanPass(tpl, { memberName: '0012345' });
    const door = await kit.scanner({ templateIds: [tpl], settings: LIST });
    // A first publication writes the hash of the barcode message: here a member number.
    const barcode = (await sha256Hex('0012345')).slice(0, 32);
    await run(kit.env.DB, 'UPDATE passes SET barcode_hash = ? WHERE id = ?', [
      await sha256Hex('0012345'),
      pass.id,
    ]);
    const hashes = (await rosterOf(door.headers)).entries.map((e) => e.h);
    expect(hashes).not.toContain(barcode);
    expect(hashes).toContain(await hashOf(pass.scanCode ?? ''));
  });

  it('marks voided passes and passes already in', async () => {
    const tpl = await ticketTemplate();
    const [voided, inside, fresh] = [
      await kit.scanPass(tpl),
      await kit.scanPass(tpl),
      await kit.scanPass(tpl),
    ];
    const door = await kit.scanner({ templateIds: [tpl], settings: LIST });
    await run(kit.env.DB, "UPDATE passes SET status='voided' WHERE id=?", [voided.id]);
    await act(door.headers, codeOf(inside));
    const by = new Map((await rosterOf(door.headers)).entries.map((e) => [e.h, e] as const));
    expect(by.get(await hashOf(voided.scanCode ?? ''))).toMatchObject({ status: 'voided' });
    expect(by.get(await hashOf(inside.scanCode ?? ''))).toMatchObject({
      status: 'active',
      state: 'in',
    });
    expect(by.get(await hashOf(fresh.scanCode ?? ''))).toMatchObject({
      status: 'active',
      state: null,
    });
  });

  it('expires in a day and is signed to its window', async () => {
    const tpl = await ticketTemplate();
    const door = await kit.scanner({ templateIds: [tpl], settings: LIST });
    const roster = await rosterOf(door.headers);
    expect(roster.validUntil - roster.asOf).toBe(24 * 60 * 60 * 1000);
    expect(roster.sig).toMatch(/^[\w-]{20,}$/);
  });

  it('a delta returns what changed since', async () => {
    const tpl = await ticketTemplate();
    const early = await kit.scanPass(tpl);
    const door = await kit.scanner({ templateIds: [tpl], settings: LIST });
    kit.clock.advance(60_000);
    const since = kit.clock.now();
    kit.clock.advance(1000);
    const late = await kit.scanPass(tpl);
    const delta = (await (await kit.get(door.headers, `/roster?since=${since}`)).json()) as {
      entries: { h: string }[];
    };
    const hashes = delta.entries.map((e) => e.h);
    expect(hashes).toContain(await hashOf(late.scanCode ?? ''));
    expect(hashes).not.toContain(await hashOf(early.scanCode ?? ''));
  });

  it('refuses when the session stops, when an action is not a check-in, and to an admin', async () => {
    const tpl = await ticketTemplate();
    const stop = await kit.scanner({ templateIds: [tpl] });
    expect((await kit.get(stop.headers, '/roster')).status).toBe(409);
    expect(await (await kit.get(stop.headers, '/roster')).json()).toMatchObject({
      code: 'OFFLINE_OFF',
    });

    const stamps = await kit.scanTemplate('Stamps', {
      actions: [{ id: 'add', label: 'Add', kind: 'add', input: 'balance' }],
    });
    const value = await kit.scanner({ templateIds: [stamps], settings: LIST });
    const res = await kit.get(value.headers, '/roster');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'OFFLINE_NEEDS_CHECK_IN' });

    expect((await kit.get(kit.admin(), '/roster?orgId=x')).status).toBeGreaterThanOrEqual(400);
  });

  it('refuses a session with zones or an in-out policy', async () => {
    const tpl = await ticketTemplate();
    const inOut = await kit.scanner({
      templateIds: [tpl],
      settings: { ...LIST, checkIn: { mode: 'in_out' } },
    });
    expect(await (await kit.get(inOut.headers, '/roster')).json()).toMatchObject({
      code: 'OFFLINE_NEEDS_ONCE_OR_DAILY',
    });
  });

  it('the device session carries the chosen mode, so the door knows what to do', async () => {
    const tpl = await ticketTemplate();
    const door = await kit.scanner({
      templateIds: [tpl],
      settings: { offline: false, whenOffline: 'decide' },
    });
    const session = (await (await kit.get(door.headers, '/session')).json()) as {
      scanner: { settings: { whenOffline?: string; offline: boolean } };
    };
    expect(session.scanner.settings).toMatchObject({ whenOffline: 'decide', offline: false });
  });

  it("marks entries of a daily check-in, so the door drops yesterday's in", async () => {
    const tpl = await kit.scanTemplate('Daily', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'daily' }],
    });
    const pass = await kit.scanPass(tpl);
    const door = await kit.scanner({ templateIds: [tpl], settings: LIST });
    const h = await hashOf(pass.scanCode ?? '');
    const entry = (await rosterOf(door.headers)).entries.find((e) => e.h === h);
    expect(entry).toMatchObject({ day: true });
  });
});
