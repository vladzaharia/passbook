import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { makeOrg, makeUser, TEST_NOW } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { accessTemplate, makeDoor } from './access-test-fixtures.ts';
import { act, CHECK_IN, HOUR, kit, setupActionFixture, tpl } from './act-test-fixtures.ts';
import { beforeBatch } from './batch-interceptor-test-support.ts';
import { RACE_GATE_WRITE } from './race-tags.ts';
import {
  actTag,
  bindTag,
  holder,
  nextUid,
  ownedPass,
  resolveTag,
  tagInput,
  tagsOn,
} from './tags-resolve-test-fixtures.ts';
import { codeOf, key, setPass, startScanCredentialTransfer } from './test-kit.ts';

beforeAll(async () => {
  await setupActionFixture();
  await tagsOn();
});
afterEach(() => kit.clock.set(TEST_NOW));

const passOf = async (scanId: string | null) =>
  (await first<{ pass_id: string }>(kit.env.DB, 'SELECT pass_id FROM scans WHERE id = ?', [scanId]))
    ?.pass_id;

const desk = () => kit.scanner({ templateIds: [tpl], settings: { roleWithoutSignIn: 'desk' } });

/** A user with two passes of the gym card, the first the tag's anchor. */
async function twoPasses() {
  const user = await holder();
  const a = await ownedPass(tpl, user);
  kit.clock.advance(1);
  const b = await ownedPass(tpl, user);
  kit.clock.set(TEST_NOW);
  const uid = nextUid();
  await bindTag(uid, a, { userId: user });
  return { user, a, b, uid };
}

describe('a user-bound tag picks one pass', () => {
  it('checks in with the second pass when the first is outside its hours', async () => {
    const access = await accessTemplate();
    const door = await makeDoor([access]);
    const user = await holder();
    const offPeak = await ownedPass(access, user, { plan: 'off_peak' });
    kit.clock.advance(1);
    const gold = await ownedPass(access, user, { plan: 'gold' });
    const uid = nextUid();
    await bindTag(uid, offPeak, { userId: user });
    kit.clock.set(TEST_NOW + 6 * HOUR); // Monday 18:00: off-peak is closed.
    const done = await actTag(door.headers, uid);
    expect(done.kind).toBe('ok');
    expect(done.tag).toBeUndefined(); // A Door never sees tag data (§7.2).
    expect(await passOf(done.scanId)).toBe(gold.id);
  });

  it('uses a member pass before a guest pass', async () => {
    const access = await accessTemplate();
    const door = await makeDoor([access]);
    const user = await holder();
    const guest = await ownedPass(access, user, { plan: 'guest' });
    kit.clock.advance(1);
    const gold = await ownedPass(access, user, { plan: 'gold' });
    const uid = nextUid();
    await bindTag(uid, guest, { userId: user });
    const done = await actTag(door.headers, uid);
    expect(done.kind).toBe('ok');
    expect(await passOf(done.scanId)).toBe(gold.id);
  });

  it('reads only the user’s live passes in this org and mode', async () => {
    const scanner = await desk();
    const user = await makeUser(kit.fx);
    const anchor = await ownedPass(tpl, user.id);
    // Waiting: an address the account has not verified, so the pass is not attached.
    await kit.scanPass(tpl, {}, { holderEmail: `waiting-${user.id}@example.com` });
    await ownedPass(tpl, user.id, {}, { mode: 'test' });
    const deleted = await ownedPass(tpl, user.id);
    await setPass(kit, deleted.id, 'deleted_at = ?', [kit.clock.now()]);
    const other = await makeOrg(kit.fx);
    const otherTpl = await kit.scanTemplate(
      'Other gym',
      { actions: [CHECK_IN] },
      { orgId: other.id },
    );
    await ownedPass(otherTpl, user.id, {}, { orgId: other.id });
    const uid = nextUid();
    await bindTag(uid, anchor, { userId: user.id });
    const done = await actTag(scanner.headers, uid);
    expect(done).toMatchObject({ kind: 'ok', tag: { count: 1 } });
    expect(await passOf(done.scanId)).toBe(anchor.id);

    await run(kit.env.DB, "UPDATE users SET status = 'disabled' WHERE id = ?", [user.id]);
    expect(await resolveTag(scanner.headers, uid)).toMatchObject({
      reason: 'not_found',
      card: null,
    });
  });

  it('answers the first pass’s refusal when none lets in, and prefers a heads-up', async () => {
    const scanner = await desk();
    const { a, b, uid } = await twoPasses();
    await setPass(kit, a.id, "status = 'voided'", []);
    await setPass(kit, b.id, "status = 'voided'", []);
    const none = await resolveTag(scanner.headers, uid);
    expect(none).toMatchObject({ kind: 'refused', reason: 'voided' });
    expect(none.tag?.passes?.map((p) => [p.passId, p.state, p.reason])).toEqual([
      [a.id, 'used', null],
      [b.id, 'refused', 'voided'],
    ]);

    const next = await twoPasses();
    expect((await act(scanner.headers, codeOf(next.b))).status).toBe(200);
    await setPass(kit, next.a.id, "status = 'voided'", []);
    const held = await actTag(scanner.headers, next.uid);
    expect(held).toMatchObject({ kind: 'heads_up' });
    expect(await passOf(held.scanId)).toBe(next.b.id);

    // Let in anyway acts on the held pass, and its undo stays there.
    const over = await actTag(scanner.headers, next.uid, { overrideOf: held.scanId });
    expect(over.kind).toBe('ok');
    expect(await passOf(over.scanId)).toBe(next.b.id);
    const undone = await kit.post(scanner.headers, `/scans/${over.scanId}/undo`, {
      idempotencyKey: key(),
    });
    expect(undone.status).toBe(200);
    const row = await first<{ pass_id: string }>(
      kit.env.DB,
      'SELECT pass_id FROM scans WHERE undoes = ?',
      [over.scanId],
    );
    expect(row?.pass_id).toBe(next.b.id);
  });

  it('honours a pin, refuses a pin outside the binding, and replays on the same pass', async () => {
    const scanner = await kit.scanner({ templateIds: [tpl] });
    const { a, b, uid } = await twoPasses();
    const pinned = await actTag(scanner.headers, uid, {}, { passId: b.id });
    expect(await passOf(pinned.scanId)).toBe(b.id);
    const stranger = await kit.scanPass(tpl);
    expect(await actTag(scanner.headers, uid, {}, { passId: stranger.id })).toMatchObject({
      kind: 'refused',
      reason: 'not_found',
      card: null,
    });

    const idempotencyKey = key();
    const once = await actTag(scanner.headers, uid, { idempotencyKey });
    expect(await passOf(once.scanId)).toBe(a.id);
    // A changes after the scan: the replay still answers with its stored pass.
    await setPass(kit, a.id, "status = 'voided'", []);
    const again = await actTag(scanner.headers, uid, { idempotencyKey });
    expect(again).toMatchObject({ replay: true, scanId: once.scanId });
  });

  it('retries an unfinished claim on the pass the tag chooses, not an empty one', async () => {
    const scanner = await kit.scanner({ templateIds: [tpl] });
    const { a, uid } = await twoPasses();
    const idempotencyKey = key();
    const { result: failed, fired } = await beforeBatch(
      kit.env,
      RACE_GATE_WRITE,
      async () => {
        throw new Error('transient D1 failure');
      },
      () => act(scanner.headers, tagInput(uid), { idempotencyKey }),
    );
    expect(fired).toBe(true);
    expect(failed.status).toBe(500);
    const retried = await actTag(scanner.headers, uid, { idempotencyKey });
    expect(retried.kind).toBe('ok');
    expect(await passOf(retried.scanId)).toBe(a.id);
  });

  it('refuses a pass transferred after the resolve', async () => {
    const scanner = await kit.scanner({ templateIds: [tpl] });
    const { a, uid } = await twoPasses();
    const shown = await resolveTag(scanner.headers, uid);
    expect(shown.card?.passId).toBe(a.id);
    await startScanCredentialTransfer(kit, a.id);
    const pinned = await actTag(scanner.headers, uid, {}, { passId: a.id });
    expect(pinned).toMatchObject({ kind: 'refused', reason: 'not_found', card: null });
    expect(await passOf(pinned.scanId)).toBeNull();
  });

  it('refuses at commit when the tag is reported lost under the scan', async () => {
    const scanner = await kit.scanner({ templateIds: [tpl] });
    const { a, uid } = await twoPasses();
    const binding = await first<{ id: string; tag_id: string }>(
      kit.env.DB,
      'SELECT id, tag_id FROM tag_bindings WHERE pass_id = ? AND ended_at IS NULL',
      [a.id],
    );
    const { result, fired } = await beforeBatch(
      kit.env,
      RACE_GATE_WRITE,
      (db) =>
        db.batch([
          db
            .prepare(
              "UPDATE tag_bindings SET ended_at = 1, ended_by_type = 'user', ended_by = 'x', end_cause = 'lost' WHERE id = ?",
            )
            .bind(binding?.id),
          db
            .prepare("UPDATE nfc_tags SET lost_at = 1, lost_by = 'x' WHERE id = ?")
            .bind(binding?.tag_id),
        ]),
      () => act(scanner.headers, tagInput(uid)),
    );
    expect(fired).toBe(true);
    expect(result.status).not.toBe(200);
    const checkedIn = await first<{ n: number }>(
      kit.env.DB,
      "SELECT count(*) AS n FROM scans WHERE pass_id = ? AND outcome = 'ok'",
      [a.id],
    );
    expect(checkedIn?.n).toBe(0);
  });
});
