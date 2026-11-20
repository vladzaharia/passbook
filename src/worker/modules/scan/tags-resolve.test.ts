import { beforeAll, describe, expect, it } from 'vitest';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { first, run } from '../../platform/db.ts';
import { kit, mask, out, setupActionFixture, tpl } from './act-test-fixtures.ts';
import {
  actTag,
  bindTag,
  holder,
  nextUid,
  ownedPass,
  resolveTag,
  tagsOn,
} from './tags-resolve-test-fixtures.ts';
import { codeOf, key, setPass } from './test-kit.ts';

beforeAll(async () => {
  await setupActionFixture();
  await tagsOn();
});

/** Outcomes compared without their per-call grant token. */
const same = (o: ScanOutcome) => {
  const masked = mask(o);
  if (masked.card)
    masked.card = { ...masked.card, passView: { ...masked.card.passView, assetGrant: '' } };
  return masked;
};

const scanPass = async (scanId: string | null) =>
  (await first<{ pass_id: string }>(kit.env.DB, 'SELECT pass_id FROM scans WHERE id = ?', [scanId]))
    ?.pass_id;

const resolveCode = async (headers: Record<string, string>, input: unknown) =>
  out(
    await kit.post(headers, '/resolve', {
      idempotencyKey: key(),
      input,
      clientTs: kit.clock.now(),
    }),
  );

describe('a tag read: step 3', () => {
  it('answers unknown, test-mode, retired, unbound, lost, switched-off and random tags', async () => {
    const scanner = await kit.scanner({ templateIds: [tpl] });
    expect(await resolveTag(scanner.headers, nextUid())).toMatchObject({
      kind: 'refused',
      reason: 'not_found',
      card: null,
    });

    const testPass = await kit.scanPass(tpl, {}, { mode: 'test' });
    const testUid = nextUid();
    await bindTag(testUid, testPass);
    expect(await resolveTag(scanner.headers, testUid)).toMatchObject({ reason: 'test_pass' });

    const pass = await kit.scanPass(tpl);
    const retired = nextUid();
    const { tagId: retiredId } = await bindTag(retired, pass);
    await run(kit.env.DB, "UPDATE nfc_tags SET status = 'retired', status_at = 1 WHERE id = ?", [
      retiredId,
    ]);
    expect(await resolveTag(scanner.headers, retired)).toMatchObject({ reason: 'not_found' });

    const unbound = nextUid();
    const { bindingId } = await bindTag(unbound, pass);
    await run(
      kit.env.DB,
      "UPDATE tag_bindings SET ended_at = 1, ended_by_type = 'user', ended_by = 'a', end_cause = 'admin' WHERE id = ?",
      [bindingId],
    );
    expect(await resolveTag(scanner.headers, unbound)).toMatchObject({ reason: 'not_found' });

    const lost = nextUid();
    const bound = await bindTag(lost, pass);
    await run(
      kit.env.DB,
      `UPDATE tag_bindings SET ended_at = 1, ended_by_type = 'user', ended_by = 'a', end_cause = 'lost' WHERE id = ?`,
      [bound.bindingId],
    );
    await run(kit.env.DB, "UPDATE nfc_tags SET lost_at = 1, lost_by = 'a' WHERE id = ?", [
      bound.tagId,
    ]);
    expect(await resolveTag(scanner.headers, lost)).toMatchObject({
      reason: 'tag_lost',
      card: null,
    });
    expect(await actTag(scanner.headers, lost)).toMatchObject({ reason: 'tag_lost', card: null });

    const live = nextUid();
    await bindTag(live, pass);
    await tagsOn(kit.org.id, false);
    expect(await resolveTag(scanner.headers, live)).toMatchObject({ reason: 'tag_not_allowed' });
    await tagsOn();

    const random = await resolveCode(scanner.headers, {
      tag: { uid: '04a1b2c3', uidRandom: true, tech: 'a', source: 'native' },
      method: 'nfc',
    });
    expect(random).toMatchObject({ reason: 'tag_invalid' });
    // A 4-byte UID starting 08 is random per session, whatever the reader says.
    const session = await resolveCode(scanner.headers, {
      tag: { uid: '08a1b2c3', tech: 'a', source: 'native' },
      method: 'nfc',
    });
    expect(session).toMatchObject({ reason: 'tag_invalid' });
  });

  it('keeps a pass code in the NDEF of an unknown tag on the code path', async () => {
    const scanner = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const outcome = await resolveCode(scanner.headers, {
      tag: {
        uid: nextUid(),
        tech: 'a',
        source: 'native',
        ndef: { type: 'T', value: pass.scanCode },
      },
      method: 'nfc',
    });
    expect(outcome).toMatchObject({ kind: 'ready', card: { passId: pass.id } });
    expect(outcome.tag).toBeUndefined();
  });
});

describe('a refused tag read at act', () => {
  it('is recorded with its reason and tag, no pass, and shows in the scanner history', async () => {
    const scanner = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const lost = nextUid();
    const lostTag = await bindTag(lost, pass);
    await run(
      kit.env.DB,
      `UPDATE tag_bindings SET ended_at = 1, ended_by_type = 'user', ended_by = 'a', end_cause = 'lost' WHERE id = ?`,
      [lostTag.bindingId],
    );
    await run(kit.env.DB, "UPDATE nfc_tags SET lost_at = 1, lost_by = 'a' WHERE id = ?", [
      lostTag.tagId,
    ]);
    const retired = nextUid();
    const retiredTag = await bindTag(retired, pass);
    await run(kit.env.DB, "UPDATE nfc_tags SET status = 'retired', status_at = 1 WHERE id = ?", [
      retiredTag.tagId,
    ]);
    const unknown = nextUid();
    const answers = [
      await actTag(scanner.headers, lost),
      await actTag(scanner.headers, retired),
      await actTag(scanner.headers, unknown),
    ];
    expect(answers.map((a) => [a.kind, a.reason, a.card])).toEqual([
      ['refused', 'tag_lost', null],
      ['refused', 'not_found', null],
      ['refused', 'not_found', null],
    ]);
    const rows = await Promise.all(
      answers.map((a) =>
        first<{
          state: string;
          outcome: string;
          reason: string;
          pass_id: null;
          tag_id: string | null;
          method: string;
        }>(
          kit.env.DB,
          'SELECT state, outcome, reason, pass_id, tag_id, method FROM scans WHERE id = ?',
          [a.scanId],
        ),
      ),
    );
    expect(rows).toEqual([
      {
        state: 'done',
        outcome: 'refused',
        reason: 'tag_lost',
        pass_id: null,
        tag_id: lostTag.tagId,
        method: 'nfc',
      },
      {
        state: 'done',
        outcome: 'refused',
        reason: 'not_found',
        pass_id: null,
        tag_id: retiredTag.tagId,
        method: 'nfc',
      },
      {
        state: 'done',
        outcome: 'refused',
        reason: 'not_found',
        pass_id: null,
        tag_id: null,
        method: 'nfc',
      },
    ]);
    const recent = (await (await kit.get(scanner.headers, '/scans?limit=20')).json()) as {
      items: { scanId: string }[];
    };
    const listed = new Set(recent.items.map((item) => item.scanId));
    expect(answers.every((a) => a.scanId && listed.has(a.scanId))).toBe(true);
  });

  it('replays a recorded refusal on the same key', async () => {
    const scanner = await kit.scanner({ templateIds: [tpl] });
    const uid = nextUid();
    const idempotencyKey = key();
    const once = await actTag(scanner.headers, uid, { idempotencyKey });
    const again = await actTag(scanner.headers, uid, { idempotencyKey });
    expect(again).toMatchObject({ replay: true, scanId: once.scanId, reason: 'not_found' });
  });
});

describe('a pass-bound tag', () => {
  it('gives the pass its own answer, checks in by tag and records the tag', async () => {
    const scanner = await kit.scanner({
      templateIds: [tpl],
      settings: { roleWithoutSignIn: 'desk' },
    });
    const pass = await kit.scanPass(tpl);
    const uid = nextUid();
    const { tagId } = await bindTag(uid, pass);
    const byCode = await resolveCode(scanner.headers, codeOf(pass));
    const byTag = await resolveTag(scanner.headers, uid);
    const { tag, ...rest } = byTag;
    expect(tag).toEqual({
      hint: expect.stringMatching(/^[0-9A-F]{4}$/),
      assurance: 'basic',
      system: 'uid',
      scope: 'pass',
    });
    expect(same(rest as typeof byTag)).toEqual(same(byCode));

    // A Door never sees tag data.
    const door = await kit.scanner({ templateIds: [tpl] });
    expect((await resolveTag(door.headers, uid)).tag).toBeUndefined();

    const done = await actTag(scanner.headers, uid);
    expect(done).toMatchObject({ kind: 'ok', tag: { scope: 'pass' } });
    const row = await first<{ tag_id: string; method: string; pass_id: string }>(
      kit.env.DB,
      'SELECT tag_id, method, pass_id FROM scans WHERE id = ?',
      [done.scanId],
    );
    expect(row).toEqual({ tag_id: tagId, method: 'nfc', pass_id: pass.id });
    const seen = await first<{ last_seen_at: number }>(
      kit.env.DB,
      'SELECT last_seen_at FROM nfc_tags WHERE id = ?',
      [tagId],
    );
    expect(seen?.last_seen_at).toBe(kit.clock.now());
  });

  it('answers voided like the code', async () => {
    const scanner = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const uid = nextUid();
    await bindTag(uid, pass);
    await setPass(kit, pass.id, "status = 'voided'", []);
    const byCode = await resolveCode(scanner.headers, codeOf(pass));
    const { tag: _, ...byTag } = await resolveTag(scanner.headers, uid);
    expect(byCode.reason).toBe('voided');
    expect(same(byTag as typeof byCode)).toEqual(same(byCode));
  });
});

describe('a user-bound tag', () => {
  it('checks in with a second pass when the first is refused', async () => {
    const scanner = await kit.scanner({
      templateIds: [tpl],
      settings: { roleWithoutSignIn: 'desk' },
    });
    const user = await holder();
    const first = await ownedPass(tpl, user);
    kit.clock.advance(1);
    const second = await ownedPass(tpl, user);
    const uid = nextUid();
    await bindTag(uid, first, { userId: user });
    await setPass(kit, first.id, "status = 'voided'", []);
    const done = await actTag(scanner.headers, uid);
    expect(done).toMatchObject({ kind: 'ok', tag: { scope: 'user', count: 2 } });
    expect(await scanPass(done.scanId)).toBe(second.id);
  });
});
