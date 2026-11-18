import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TEST_NOW } from '../../../../test/helpers/index.ts';
import { first } from '../../platform/db.ts';
import { accessTemplate } from './access-test-fixtures.ts';
import { act, kit, MINUTE, setupActionFixture, tpl } from './act-test-fixtures.ts';
import { placeRow, scanAt, trackedZone, zoneDoor } from './occupancy-scan-test-fixtures.ts';
import {
  actTag,
  bindTag,
  holder,
  nextUid,
  ownedPass,
  tagInput,
  tagsOn,
} from './tags-resolve-test-fixtures.ts';
import { codeOf, key, setPass } from './test-kit.ts';
import { tripsFrom } from './trips-test-support.ts';

beforeAll(async () => {
  await setupActionFixture();
  await tagsOn();
});
afterEach(() => kit.clock.set(TEST_NOW));

const passOf = async (scanId: string | null) =>
  (await first<{ pass_id: string }>(kit.env.DB, 'SELECT pass_id FROM scans WHERE id = ?', [scanId]))
    ?.pass_id;

describe('a user-bound tag at an In/Out door', () => {
  it('taps out the pass that is inside, not the anchor', async () => {
    const access = await accessTemplate();
    const gym = await trackedZone();
    const door = await zoneDoor(access, [gym], 'both');
    const user = await holder();
    const anchor = await ownedPass(access, user, { plan: 'gold' });
    kit.clock.advance(1);
    const inside = await ownedPass(access, user, { plan: 'gold' });
    const uid = nextUid();
    await bindTag(uid, anchor, { userId: user });
    expect((await scanAt(door, inside)).kind).toBe('ok');
    kit.clock.advance(10 * MINUTE);
    const left = await actTag(door.headers, uid, { actionId: 'check_in' });
    expect(left).toMatchObject({ kind: 'ok', occupancy: { direction: 'out', state: 'out' } });
    expect(await passOf(left.scanId)).toBe(inside.id);
    expect(await placeRow(inside.id, gym)).toMatchObject({ state: 'out' });
    expect(await placeRow(anchor.id, gym)).toBeNull();
  });
});

describe('tag round trips (design §4.3)', () => {
  const trips = async (work: () => Promise<unknown>) =>
    (await tripsFrom(kit.env, /FROM scans|nfc_tags/, work)).trips;

  it('a pass-bound tag takes no more trips than its code; each further pass at most two', async () => {
    const scanner = await kit.scanner({ templateIds: [tpl] });
    const byCode = await kit.scanPass(tpl);
    const byTag = await kit.scanPass(tpl);
    const uid = nextUid();
    await bindTag(uid, byTag);
    const code = await trips(() => act(scanner.headers, codeOf(byCode)));
    const tag = await trips(() => act(scanner.headers, tagInput(uid)));
    expect(tag).toBeLessThanOrEqual(code);

    const user = await holder();
    const refused = await ownedPass(tpl, user);
    kit.clock.advance(1);
    const second = await ownedPass(tpl, user);
    const userUid = nextUid();
    await bindTag(userUid, refused, { userId: user });
    await setPass(kit, refused.id, "status = 'voided'", []);
    let scanId: string | null = null;
    const both = await trips(async () => {
      scanId = (await actTag(scanner.headers, userUid)).scanId;
    });
    expect(await passOf(scanId)).toBe(second.id);
    expect(both).toBeLessThanOrEqual(code + 2 * 2);
  });
});

describe('live rows', () => {
  it('carry no tag data and never reach a customer screen', async () => {
    const scanner = await kit.scanner({ templateIds: [tpl] });
    await kit.scanner({ deviceRole: 'monitor' });
    const pass = await kit.scanPass(tpl);
    const uid = nextUid();
    await bindTag(uid, pass);
    const delivered: unknown[] = [];
    const original = kit.env.SCAN_HUB;
    Object.assign(kit.env, {
      SCAN_HUB: {
        getByName: () => ({
          publish: async (event: unknown) => {
            delivered.push(event);
            return true;
          },
        }),
      },
    });
    try {
      const res = await kit.post(scanner.headers, '/actions', {
        idempotencyKey: key(),
        input: tagInput(uid),
        clientTs: kit.clock.now(),
        actionId: 'check_in',
      });
      const outcome = await res.json();
      expect(outcome).toMatchObject({ kind: 'ok', tag: { scope: 'pass' } });
      await vi.waitFor(() => expect(delivered).toHaveLength(1), { timeout: 5000 });
      const event = delivered[0] as { row: { row: Record<string, unknown> } };
      expect(event.row.row).toMatchObject({ passId: pass.id, presented: false });
      const text = JSON.stringify(event);
      expect(text).not.toContain('"tag"');
      expect(text).not.toContain(uid);
    } finally {
      Object.assign(kit.env, { SCAN_HUB: original });
    }
  });
});
