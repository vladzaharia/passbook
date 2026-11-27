import { beforeEach, describe, expect, it } from 'vitest';
import { expectSecretAbsent } from '../../../../test/helpers/secret-absent.ts';
import {
  assignCmd,
  bindResultOf,
  cardReadEvent,
  inspectOf,
  passReadEvent,
  run,
  tagOf,
  tagReadEvent,
} from './assign.test-support.ts';
import { ASSIGN_TIMING } from './assign-state.ts';
import { assignOf, stripOfAssign } from './assign-view.ts';
import { fixtureState } from './fixtures.test-support.ts';
import { at, hasCmd, resetIds, step } from './reduce.test-support.ts';
import type { ScanState } from './types.ts';

beforeEach(resetIds);
const started = (): ScanState => fixtureState({ started: true, camera: 'live' });
const opened = () => step(started(), { type: 'assign.open', from: 'menu' }, at(0)).state;

/** tag read, inspected: ready for the pass. */
function tagged(uid?: string) {
  const r = run(opened(), [100, tagReadEvent(tagOf(uid))]);
  const inspect = assignCmd(r.cmds, 'assign.inspect');
  return {
    ...run(r.state, [200, { type: 'assign.inspected', key: inspect.key, result: inspectOf() }]),
    inspect,
  };
}

/** card read, previewed: on the confirm step. */
function confirming() {
  const t = tagged();
  const r = run(t.state, [300, cardReadEvent()]);
  const bind = assignCmd(r.cmds, 'assign.bind');
  const p = run(r.state, [
    400,
    { type: 'assign.previewed', key: bind.key, result: bindResultOf() },
  ]);
  return { ...p, preview: bind };
}

describe('opening Assign tag', () => {
  it('opens at the tag step, with the pair buddy and the idle clock', () => {
    const r = step(started(), { type: 'assign.open', from: 'menu' }, at(0));
    expect(assignOf(r.state)).toMatchObject({ step: 'tag', source: 'menu', busy: null });
    expect(r.cmds).toContainEqual({ c: 'beat', beat: 'pair' });
    expect(assignOf(r.state)?.idleAt).toBe(at(ASSIGN_TIMING.IDLE));
  });

  it('says Tag needs a connection and stays closed when offline', () => {
    const r = step({ ...started(), online: false }, { type: 'assign.open', from: 'menu' }, at(0));
    expect(assignOf(r.state)).toBeNull();
    expect(r.cmds).toContainEqual({
      c: 'announce',
      text: 'Tag needs a connection',
      polite: false,
    });
  });

  it('does not open before Start or behind a block', () => {
    expect(
      assignOf(step(fixtureState({ started: false }), { type: 'assign.open', from: 'menu' }).state),
    ).toBeNull();
    expect(
      assignOf(step({ ...started(), block: 'staff' }, { type: 'assign.open', from: 'menu' }).state),
    ).toBeNull();
  });

  it('opens at the pass step with the tag already read (an unknown tag at the door)', () => {
    const tag = tagOf('11223344');
    const r = step(
      started(),
      { type: 'assign.open', from: 'unknown_tag', tag, sig: 't:11223344' },
      at(0),
    );
    expect(assignOf(r.state)).toMatchObject({ step: 'pass', tag: { sig: 't:11223344' } });
  });
});

describe('tag, card, preview, scope, bind, undo', () => {
  it('walks the whole flow and asks the server for each step under its own key', () => {
    const t = tagged();
    expect(assignOf(t.state)).toMatchObject({ step: 'pass', busy: null });
    expect(t.inspect.tag.uid).toBe('04a2b3c4d5e6f7');

    const c = confirming();
    expect(c.preview.body).toMatchObject({
      preview: true,
      binding: 'pass',
      card: { code: 'CARD-0001', method: 'camera' },
    });
    expect(assignOf(c.state)).toMatchObject({ step: 'confirm', scope: 'pass', busy: null });

    const user = step(c.state, { type: 'assign.scope', scope: 'user' }, at(500));
    expect(assignOf(user.state)?.scope).toBe('user');
    const labelled = step(user.state, { type: 'assign.label', label: 'Blue fob' }, at(510));
    const bound = step(labelled.state, { type: 'assign.bind' }, at(520));
    const cmd = assignCmd(bound.cmds, 'assign.bind');
    expect(cmd.body).toMatchObject({ preview: false, binding: 'user', label: 'Blue fob' });
    expect(cmd.key).not.toBe(c.preview.key);
    expect(assignOf(bound.state)?.busy).toBe('bind');

    const done = step(
      bound.state,
      {
        type: 'assign.bound',
        key: cmd.key,
        result: bindResultOf({
          status: 'bound',
          scope: 'user',
          bindingId: 'b1',
          undoUntil: at(600_000),
        }),
      },
      at(600),
    );
    expect(assignOf(done.state)).toMatchObject({ step: 'done', busy: null });
    expect(hasCmd(done.cmds, 'sound')).toBe(true);
    // Assign mode never auto-dismisses a success.
    const later = step(done.state, { type: 'tick' }, at(600 + ASSIGN_TIMING.IDLE * 3));
    expect(assignOf(later.state)?.step).toBe('done');

    const undone = step(done.state, { type: 'assign.undo' }, at(700));
    const undoCmd = assignCmd(undone.cmds, 'assign.undo');
    expect(undoCmd.bindingId).toBe('b1');
    const gone = step(undone.state, { type: 'assign.undone', key: undoCmd.key }, at(800));
    expect(assignOf(gone.state)).toBeNull();
    expect(stripOfAssign(gone.state)?.kind).toBe('undone');
  });

  it('keeps a typed name to 24 characters and offers the person only with an account', () => {
    const c = confirming();
    const long = step(c.state, { type: 'assign.label', label: 'x'.repeat(40) }, at(500));
    expect(assignOf(long.state)?.label).toHaveLength(24);

    const t = tagged();
    const r = run(t.state, [300, cardReadEvent()]);
    const bind = assignCmd(r.cmds, 'assign.bind');
    const none = run(
      r.state,
      [
        400,
        { type: 'assign.previewed', key: bind.key, result: bindResultOf({ ownerAccount: false }) },
      ],
      [410, { type: 'assign.scope', scope: 'user' }],
    );
    expect(assignOf(none.state)?.scope).toBe('pass');
  });

  it('drops an answer for another key, and a second tag while a call is out', () => {
    const r = run(opened(), [100, tagReadEvent()]);
    const inspect = assignCmd(r.cmds, 'assign.inspect');
    const stale = step(
      r.state,
      { type: 'assign.inspected', key: 'other', result: inspectOf() },
      at(150),
    );
    expect(assignOf(stale.state)?.busy).toBe('inspect');
    const again = step(r.state, tagReadEvent(tagOf('99999999'), 160), at(160));
    expect(again.cmds).toEqual([]);
    expect(inspect.tag.uid).toBe('04a2b3c4d5e6f7');
  });

  it('Back from confirm returns to the pass, or to the tag when the pass was known', () => {
    const c = confirming();
    const back = step(c.state, { type: 'assign.back' }, at(500));
    expect(assignOf(back.state)).toMatchObject({ step: 'pass', card: null });
    expect(assignOf(back.state)?.tag).not.toBeNull();

    const known = step(
      started(),
      { type: 'assign.open', from: 'card', card: { code: 'CARD-0001', method: 'camera' } },
      at(0),
    );
    const t = run(known.state, [100, tagReadEvent()]);
    const inspect = assignCmd(t.cmds, 'assign.inspect');
    const i = step(
      t.state,
      { type: 'assign.inspected', key: inspect.key, result: inspectOf() },
      at(200),
    );
    // The pass is known: no scan step, straight to the preview.
    const prev = assignCmd(i.cmds, 'assign.bind');
    expect(prev.body.preview).toBe(true);
    const p = step(
      i.state,
      { type: 'assign.previewed', key: prev.key, result: bindResultOf() },
      at(300),
    );
    const b = step(p.state, { type: 'assign.back' }, at(400));
    expect(assignOf(b.state)).toMatchObject({ step: 'tag', tag: null });
    expect(assignOf(b.state)?.card).toEqual({ code: 'CARD-0001', method: 'camera' });
  });

  it('Assign another starts clean; Try another tag keeps a known pass', () => {
    const c = confirming();
    const bind = step(c.state, { type: 'assign.bind' }, at(500));
    const cmd = assignCmd(bind.cmds, 'assign.bind');
    const done = step(
      bind.state,
      {
        type: 'assign.bound',
        key: cmd.key,
        result: bindResultOf({ status: 'bound', bindingId: 'b1' }),
      },
      at(600),
    );
    const next = step(done.state, { type: 'assign.again', keepPass: false }, at(700));
    expect(assignOf(next.state)).toMatchObject({
      step: 'tag',
      tag: null,
      card: null,
      result: null,
    });
  });
});

describe('what the step does with the wrong kind of read', () => {
  it('a pass at step 1 is an amber note, not a step change', () => {
    const r = step(opened(), cardReadEvent(), at(100));
    expect(assignOf(r.state)).toMatchObject({ step: 'tag', note: { kind: 'is_pass' } });
    expect(r.cmds).toEqual([]);
    const gone = step(r.state, { type: 'tick' }, at(100 + ASSIGN_TIMING.NOTE));
    expect(assignOf(gone.state)?.note).toBeNull();
  });

  it('a tag at step 2 is an amber note and the tag is kept', () => {
    const t = tagged();
    const r = step(t.state, tagReadEvent(tagOf('99999999')), at(300));
    expect(assignOf(r.state)).toMatchObject({ step: 'pass', note: { kind: 'is_tag' } });
    expect(assignOf(r.state)?.tag?.read.uid).toBe('04a2b3c4d5e6f7');
  });

  it('a link of ours is not a pass: a red banner and the camera keeps reading', () => {
    const t = tagged();
    const read = cardReadEvent('https://x.test/p/abc');
    if (read.type !== 'read') throw new Error('read');
    const r = step(
      t.state,
      { type: 'read', input: { ...read.input, local: 'not_found' } },
      at(300),
    );
    expect(assignOf(r.state)).toMatchObject({ step: 'pass', banner: 'not_found' });
    expect(r.cmds.some((c) => (c as { c: string }).c === 'assign.bind')).toBe(false);
  });

  it('a tag with no ID or record cannot be read, and the web says so', () => {
    const r = step(opened(), tagReadEvent({ tech: 'unknown', source: 'webnfc' }), at(100));
    expect(assignOf(r.state)).toMatchObject({
      step: 'error',
      error: { kind: 'unreadable', web: true },
    });
  });
});

describe('inspect answers', () => {
  const inspectWith = (result: ReturnType<typeof inspectOf>, uid?: string) => {
    const r = run(opened(), [100, tagReadEvent(tagOf(uid))]);
    const { key } = assignCmd(r.cmds, 'assign.inspect');
    return assignOf(step(r.state, { type: 'assign.inspected', key, result }, at(200)).state);
  };
  it.each([
    [inspectOf({ state: 'lost', lostAt: 5 }), 'lost'],
    [inspectOf({ state: 'not_allowed' }), 'secure_needed'],
    [inspectOf({ state: 'invalid' }), 'unreadable'],
    [inspectOf({ state: 'retired' }), 'unreadable'],
  ] as const)('%j is the %s error', (result, kind) => {
    expect(inspectWith(result)).toMatchObject({ step: 'error', error: { kind } });
  });

  it('an invalid random tag says it changes its ID', () => {
    const r = run(opened(), [100, tagReadEvent(tagOf('08112233', { uidRandom: true }))]);
    const { key } = assignCmd(r.cmds, 'assign.inspect');
    const a = assignOf(
      step(
        r.state,
        { type: 'assign.inspected', key, result: inspectOf({ state: 'invalid' }) },
        at(200),
      ).state,
    );
    expect(a?.error?.kind).toBe('random_id');
  });

  it('a tag bound elsewhere goes on to the pass: assigning moves it', () => {
    expect(
      inspectWith(
        inspectOf({
          state: 'bound',
          bound: { scope: 'pass', passTitle: 'Pool', holderName: null },
        }),
      ),
    ).toMatchObject({ step: 'pass' });
  });

  it('an already-bound preview is the amber Already on this pass', () => {
    const t = tagged();
    const r = run(t.state, [300, cardReadEvent()]);
    const bind = assignCmd(r.cmds, 'assign.bind');
    const p = step(
      r.state,
      {
        type: 'assign.previewed',
        key: bind.key,
        result: bindResultOf({ status: 'already_bound' }),
      },
      at(400),
    );
    expect(assignOf(p.state)).toMatchObject({ step: 'error', error: { kind: 'already_here' } });
  });
});

describe('failures', () => {
  const failEvent = (key: string, over: Record<string, unknown>) =>
    ({ type: 'assign.failed', key, code: null, status: 0, network: false, ...over }) as const;

  it('a pass the server refuses shows a banner and the camera keeps reading', () => {
    const t = tagged();
    const r = run(t.state, [300, cardReadEvent()]);
    const { key } = assignCmd(r.cmds, 'assign.bind');
    const f = step(r.state, failEvent(key, { code: 'TAG_PASS_VOIDED', status: 409 }), at(400));
    expect(assignOf(f.state)).toMatchObject({ step: 'pass', banner: 'voided', busy: null });
    // A new read clears it.
    const again = step(f.state, cardReadEvent('CARD-0002'), at(500));
    expect(assignOf(again.state)).toMatchObject({ banner: null, busy: 'preview' });
  });

  it.each([
    ['TAG_LOST', 409, 'lost'],
    ['TAG_UID_RANDOM', 422, 'random_id'],
    ['TAG_UNREADABLE', 422, 'unreadable'],
    ['TAG_CHECK_FAILED', 409, 'failed_check'],
    ['TAGS_OFF', 409, 'off'],
    ['TAG_LIMIT', 409, 'limit'],
    ['SOMETHING_ELSE', 500, 'went_wrong'],
  ] as const)('%s becomes %s', (code, status, kind) => {
    const r = run(opened(), [100, tagReadEvent()]);
    const { key } = assignCmd(r.cmds, 'assign.inspect');
    const f = step(r.state, failEvent(key, { code, status }), at(200));
    expect(assignOf(f.state)).toMatchObject({ step: 'error', error: { kind } });
  });

  it('no connection is Not assigned, and Try again resends the same call under a new key', () => {
    const c = confirming();
    const bind = step(c.state, { type: 'assign.bind' }, at(500));
    const cmd = assignCmd(bind.cmds, 'assign.bind');
    const f = step(bind.state, failEvent(cmd.key, { network: true }), at(600));
    expect(assignOf(f.state)).toMatchObject({ step: 'error', error: { kind: 'not_assigned' } });
    const retry = step(f.state, { type: 'assign.retry' }, at(700));
    const again = assignCmd(retry.cmds, 'assign.bind');
    expect(again.body).toEqual(cmd.body);
    expect(again.key).not.toBe(cmd.key);
    expect(assignOf(retry.state)).toMatchObject({ step: 'confirm', busy: 'bind' });
  });

  it('a rate limit says how long', () => {
    const r = run(opened(), [100, tagReadEvent()]);
    const { key } = assignCmd(r.cmds, 'assign.inspect');
    const f = step(r.state, failEvent(key, { status: 429, retryAfterMs: 20_000 }), at(200));
    expect(assignOf(f.state)?.error).toEqual({ kind: 'too_many', seconds: 20 });
  });

  it("holding another holder's tag asks a manager: the PIN sheet, then the same bind with move and approval", () => {
    const c = confirming();
    const bind = step(c.state, { type: 'assign.bind' }, at(500));
    const cmd = assignCmd(bind.cmds, 'assign.bind');
    const held = step(
      bind.state,
      failEvent(cmd.key, { code: 'TAG_HELD_BY_OTHER', status: 409 }),
      at(600),
    );
    expect(assignOf(held.state)).toMatchObject({
      step: 'confirm',
      pin: { open: true, move: true },
    });
    const approved = step(
      held.state,
      { type: 'assign.approve', staffId: 's1', pin: '123456' },
      at(700),
    );
    const out = assignCmd(approved.cmds, 'assign.bind');
    expect(out.body).toMatchObject({ move: true, approval: { staffId: 's1', pin: '123456' } });
    // A wrong PIN keeps the sheet and shows the tries left; the PIN is never kept for a retry.
    const wrong = step(
      approved.state,
      failEvent(out.key, { code: 'PIN_INVALID', status: 400, triesLeft: 2 }),
      at(800),
    );
    expect(assignOf(wrong.state)?.pin).toMatchObject({ open: true, note: { triesLeft: 2 } });
    expectSecretAbsent(JSON.stringify(assignOf(approved.state)?.retry), '123456');
  });

  it('an undo that comes too late says so and leaves the card', () => {
    const c = confirming();
    const bind = step(c.state, { type: 'assign.bind' }, at(500));
    const cmd = assignCmd(bind.cmds, 'assign.bind');
    const done = step(
      bind.state,
      {
        type: 'assign.bound',
        key: cmd.key,
        result: bindResultOf({ status: 'bound', bindingId: 'b1' }),
      },
      at(600),
    );
    const u = step(done.state, { type: 'assign.undo' }, at(700));
    const undo = assignCmd(u.cmds, 'assign.undo');
    const f = step(
      u.state,
      failEvent(undo.key, { code: 'TAG_UNDO_EXPIRED', status: 403 }),
      at(800),
    );
    expect(assignOf(f.state)).toMatchObject({ step: 'done', busy: null });
    expect(f.cmds[0]).toMatchObject({ c: 'announce', polite: false });
  });
});

describe('ending the loop', () => {
  it('Cancel tucks the card and the strip reads Assign tag cancelled', () => {
    const r = step(opened(), { type: 'assign.cancel' }, at(100));
    expect(assignOf(r.state)).toBeNull();
    expect(stripOfAssign(r.state)).toMatchObject({ kind: 'cancelled' });
  });

  it('Escape (dismiss) cancels it too', () => {
    const r = step(opened(), { type: 'dismiss' }, at(100));
    expect(stripOfAssign(r.state)?.kind).toBe('cancelled');
  });

  it('two minutes with no input times out; any input pushes it', () => {
    const o = opened();
    const touched = step(o, cardReadEvent(), at(60_000));
    expect(assignOf(touched.state)?.idleAt).toBe(at(60_000 + ASSIGN_TIMING.IDLE));
    const early = step(touched.state, { type: 'tick' }, at(ASSIGN_TIMING.IDLE));
    expect(assignOf(early.state)).not.toBeNull();
    const late = step(touched.state, { type: 'tick' }, at(60_000 + ASSIGN_TIMING.IDLE));
    expect(assignOf(late.state)).toBeNull();
    expect(stripOfAssign(late.state)?.kind).toBe('timedOut');
  });

  it('a call in flight holds the time-out off', () => {
    const r = run(opened(), [100, tagReadEvent()]);
    const t = step(r.state, { type: 'tick' }, at(100 + ASSIGN_TIMING.IDLE + 1));
    expect(assignOf(t.state)).not.toBeNull();
  });

  it('Done after success leaves a strip with Undo until the server window ends', () => {
    const c = confirming();
    const bind = step(c.state, { type: 'assign.bind' }, at(500));
    const cmd = assignCmd(bind.cmds, 'assign.bind');
    const done = step(
      bind.state,
      {
        type: 'assign.bound',
        key: cmd.key,
        result: bindResultOf({ status: 'bound', bindingId: 'b1', undoUntil: at(600_000) }),
      },
      at(600),
    );
    const closed = step(done.state, { type: 'assign.done' }, at(700));
    expect(stripOfAssign(closed.state)).toMatchObject({
      kind: 'assigned',
      bindingId: 'b1',
      name: 'Maya Okafor',
    });
    const idle = step(closed.state, { type: 'tick' }, at(700 + ASSIGN_TIMING.STRIP + 1));
    expect(stripOfAssign(idle.state)).not.toBeNull();
    const over = step(idle.state, { type: 'tick' }, at(600_001));
    expect(stripOfAssign(over.state)).toBeNull();
    // Undo from the strip.
    const u = step(closed.state, { type: 'assign.undo' }, at(800));
    const undo = assignCmd(u.cmds, 'assign.undo');
    const gone = step(u.state, { type: 'assign.undone', key: undo.key }, at(900));
    expect(stripOfAssign(gone.state)?.kind).toBe('undone');
  });
});

describe("a result card's Add tag", () => {
  it('opens from a held card, tucks it, and knows the pass', () => {
    const r = step(
      started(),
      { type: 'assign.open', from: 'card', card: { passId: 'p1', method: 'manual' } },
      at(0),
    );
    expect(assignOf(r.state)).toMatchObject({
      source: 'card',
      step: 'tag',
      card: { passId: 'p1' },
    });
    expect(r.state.card).toBeNull();
  });
});

describe('a USB reader', () => {
  it('types the tag ID: at the tag step an ID-shaped code is the tag, with the same signature as other readers', () => {
    const r = step(
      opened(),
      {
        type: 'read',
        input: {
          code: '04A2B3C4',
          method: 'wedge',
          sig: 'c:04A2B3C4',
          id: 'x',
          at: at(100),
        },
      },
      at(100),
    );
    const cmd = assignCmd(r.cmds, 'assign.inspect');
    expect(cmd.tag).toEqual({ uid: '04a2b3c4', tech: 'unknown', source: 'native' });
    expect(assignOf(r.state)?.tag?.sig).toBe('t:04a2b3c4');
  });

  it('a barcode at the tag step is still a pass', () => {
    const r = step(
      opened(),
      {
        type: 'read',
        input: { code: 'CARD-0001', method: 'wedge', sig: 'c:CARD-0001', id: 'x', at: at(100) },
      },
      at(100),
    );
    expect(assignOf(r.state)?.note?.kind).toBe('is_pass');
  });
});

describe('what the tag opens by default', () => {
  const previewWith = (over: Parameters<typeof bindResultOf>[0]) => {
    const t = tagged();
    const r = run(t.state, [300, cardReadEvent()]);
    const bind = assignCmd(r.cmds, 'assign.bind');
    return run(r.state, [
      400,
      { type: 'assign.previewed', key: bind.key, result: bindResultOf(over) },
    ]);
  };
  it("a template that opens the person starts on all of the person's passes", () => {
    expect(assignOf(previewWith({ opensDefault: 'user' }).state)?.scope).toBe('user');
  });
  it('a person without an account stays on the pass, and an absent default is the pass', () => {
    expect(assignOf(previewWith({ opensDefault: 'user', ownerAccount: false }).state)?.scope).toBe(
      'pass',
    );
    expect(assignOf(previewWith({}).state)?.scope).toBe('pass');
    expect(assignOf(previewWith({ opensDefault: 'pass' }).state)?.scope).toBe('pass');
  });
  it('the desk can still change it', () => {
    const c = previewWith({ opensDefault: 'user' });
    const r = step(c.state, { type: 'assign.scope', scope: 'pass' }, at(500));
    expect(assignOf(r.state)?.scope).toBe('pass');
  });
  it('a tag clicked on plays the link beat', () => {
    const c = confirming();
    const bind = step(c.state, { type: 'assign.bind' }, at(500));
    const cmd = assignCmd(bind.cmds, 'assign.bind');
    const done = step(
      bind.state,
      {
        type: 'assign.bound',
        key: cmd.key,
        result: bindResultOf({ status: 'bound', bindingId: 'b1' }),
      },
      at(600),
    );
    expect(done.cmds).toContainEqual({ c: 'beat', beat: 'link' });
  });
});

describe('a pass picked in Look up', () => {
  const failEvent = (key: string, over: Record<string, unknown>) =>
    ({ type: 'assign.failed', key, code: null, status: 0, network: false, ...over }) as const;
  const picked = () => {
    const t = tagged();
    const r = run(t.state, [300, passReadEvent()]);
    return { ...r, bind: assignCmd(r.cmds, 'assign.bind') };
  };
  it('previews by pass id, and records no check-in', () => {
    const r = picked();
    expect(r.bind.body).toMatchObject({ preview: true, card: { passId: expect.any(String) } });
    expect(r.cmds.some((c) => c.c === 'act' || c.c === 'resolve')).toBe(false);
  });
  it('a pass id asks a non-manager for the PIN on the pass step, not a blank confirm', () => {
    const r = picked();
    const f = step(
      r.state,
      failEvent(r.bind.key, { code: 'TAG_APPROVAL_REQUIRED', status: 403 }),
      at(400),
    );
    expect(assignOf(f.state)).toMatchObject({
      step: 'pass',
      busy: null,
      preview: null,
      pin: { open: true },
    });
    expect(f.cmds.some((c) => c.c === 'act')).toBe(false);
  });
  it('the PIN sends the same preview with the approval, then the confirm step opens', () => {
    const r = picked();
    const f = step(
      r.state,
      failEvent(r.bind.key, { code: 'TAG_APPROVAL_REQUIRED', status: 403 }),
      at(400),
    );
    const ok = step(f.state, { type: 'assign.approve', staffId: 'm1', pin: '1234' }, at(500));
    const cmd = assignCmd(ok.cmds, 'assign.bind');
    expect(cmd.body).toMatchObject({ preview: true, approval: { staffId: 'm1', pin: '1234' } });
    expect(assignOf(ok.state)?.busy).toBe('preview');
    const done = step(
      ok.state,
      { type: 'assign.previewed', key: cmd.key, result: bindResultOf() },
      at(600),
    );
    expect(assignOf(done.state)).toMatchObject({ step: 'confirm', pin: null });
    expect(done.cmds.some((c) => c.c === 'act')).toBe(false);
  });
  it('a wrong PIN keeps the sheet open on the pass step', () => {
    const r = picked();
    const f = step(
      r.state,
      failEvent(r.bind.key, { code: 'TAG_APPROVAL_REQUIRED', status: 403 }),
      at(400),
    );
    const ok = step(f.state, { type: 'assign.approve', pin: '0000' }, at(500));
    const cmd = assignCmd(ok.cmds, 'assign.bind');
    const bad = step(
      ok.state,
      failEvent(cmd.key, { code: 'PIN_INVALID', status: 403, triesLeft: 2 }),
      at(600),
    );
    expect(assignOf(bad.state)).toMatchObject({ step: 'pass', pin: { open: true } });
  });
  it('closing the sheet leaves the pass step', () => {
    const r = picked();
    const f = step(
      r.state,
      failEvent(r.bind.key, { code: 'TAG_APPROVAL_REQUIRED', status: 403 }),
      at(400),
    );
    const c = step(f.state, { type: 'assign.pin', open: false }, at(450));
    expect(assignOf(c.state)).toMatchObject({ step: 'pass', pin: null });
  });
});

describe('a person scope the binder may not use', () => {
  const failEvent = (key: string, over: Record<string, unknown>) =>
    ({ type: 'assign.failed', key, code: null, status: 0, network: false, ...over }) as const;
  it.each([
    ['TAG_ASSIGN_FORBIDDEN', 'person_off'],
    ['TAG_TYPE_SCOPE', 'type_pass'],
  ] as const)('%s returns to confirm on this pass, with the reason', (code, kind) => {
    const c = confirming();
    const user = step(c.state, { type: 'assign.scope', scope: 'user' }, at(500));
    const bind = step(user.state, { type: 'assign.bind' }, at(510));
    const cmd = assignCmd(bind.cmds, 'assign.bind');
    const f = step(bind.state, failEvent(cmd.key, { code, status: 403 }), at(600));
    expect(assignOf(f.state)).toMatchObject({
      step: 'confirm',
      scope: 'pass',
      busy: null,
      note: { kind },
    });
  });
});

describe('the Manager approval of a pass picked by id', () => {
  const failEvent = (key: string, over: Record<string, unknown>) =>
    ({ type: 'assign.failed', key, code: null, status: 0, network: false, ...over }) as const;
  /** Picked, PIN asked, PIN given: the approval waits in memory for the bind. */
  const approvedPreview = () => {
    const t = tagged();
    const r = run(t.state, [300, passReadEvent()]);
    const first = assignCmd(r.cmds, 'assign.bind');
    const asked = step(
      r.state,
      failEvent(first.key, { code: 'TAG_APPROVAL_REQUIRED', status: 403 }),
      at(400),
    );
    const ok = step(asked.state, { type: 'assign.approve', staffId: 'm1', pin: '123456' }, at(500));
    const cmd = assignCmd(ok.cmds, 'assign.bind');
    const done = step(
      ok.state,
      { type: 'assign.previewed', key: cmd.key, result: bindResultOf() },
      at(600),
    );
    return { ...done, cmd };
  };
  it('rides the one bind, so the confirm step does not ask again', () => {
    const p = approvedPreview();
    expect(assignOf(p.state)).toMatchObject({
      step: 'confirm',
      pin: null,
      approved: { staffId: 'm1', pin: '123456' },
    });
    const b = step(p.state, { type: 'assign.bind' }, at(700));
    expect(assignCmd(b.cmds, 'assign.bind').body).toMatchObject({
      preview: false,
      approval: { staffId: 'm1', pin: '123456' },
    });
  });
  it('is wiped after the bind, and a retry never carries it', () => {
    const p = approvedPreview();
    const b = step(p.state, { type: 'assign.bind' }, at(700));
    const a = assignOf(b.state);
    expect(a?.approved).toBeNull();
    expectSecretAbsent(JSON.stringify(a?.retry), '123456');
  });
  it('is wiped by Back and by a refusal, and gone with a cancel', () => {
    const p = approvedPreview();
    expect(assignOf(step(p.state, { type: 'assign.back' }, at(700)).state)?.approved).toBeNull();
    const b = step(p.state, { type: 'assign.bind' }, at(700));
    const key = assignCmd(b.cmds, 'assign.bind').key;
    const refused = step(
      b.state,
      failEvent(key, { code: 'TAG_PASS_VOIDED', status: 409 }),
      at(800),
    );
    expect(assignOf(refused.state)?.approved).toBeNull();
    expect(assignOf(step(p.state, { type: 'assign.cancel' }, at(900)).state)).toBeNull();
  });
  it('an approved preview refused with a banner closes the PIN sheet and keeps no approval (LOW-7)', () => {
    const t = tagged();
    const r = run(t.state, [300, passReadEvent()]);
    const first = assignCmd(r.cmds, 'assign.bind');
    const asked = step(
      r.state,
      failEvent(first.key, { code: 'TAG_APPROVAL_REQUIRED', status: 403 }),
      at(400),
    );
    const ok = step(asked.state, { type: 'assign.approve', pin: '123456' }, at(500));
    const cmd = assignCmd(ok.cmds, 'assign.bind');
    const f = step(
      ok.state,
      failEvent(cmd.key, { code: 'TAG_PASS_NOT_ACCEPTED', status: 403 }),
      at(600),
    );
    expect(assignOf(f.state)).toMatchObject({
      step: 'pass',
      banner: 'not_accepted',
      pin: null,
      approved: null,
    });
  });
});

describe('a move and a changed scope under a stored approval', () => {
  const failEvent = (key: string, over: Record<string, unknown>) =>
    ({ type: 'assign.failed', key, code: null, status: 0, network: false, ...over }) as const;
  const previewing = (warnings: ('lost' | 'held_by_other')[]) => {
    const t = tagged();
    const r = run(t.state, [300, cardReadEvent()]);
    const bind = assignCmd(r.cmds, 'assign.bind');
    return run(r.state, [
      400,
      { type: 'assign.previewed', key: bind.key, result: bindResultOf({ warnings }) },
    ]);
  };
  it.each([['lost'], ['held_by_other']] as const)(
    'a Desk finishes a %s move with one PIN: the bind carries move and the approval',
    (warning) => {
      const p = previewing([warning]);
      const open = step(p.state, { type: 'assign.pin', open: true, move: true }, at(500));
      const ok = step(
        open.state,
        { type: 'assign.approve', staffId: 'm1', pin: '123456' },
        at(600),
      );
      const cmd = assignCmd(ok.cmds, 'assign.bind');
      expect(cmd.body).toMatchObject({
        preview: false,
        move: true,
        approval: { staffId: 'm1', pin: '123456' },
      });
      expect(assignOf(ok.state)).toMatchObject({ busy: 'bind', approved: null });
      expectSecretAbsent(JSON.stringify(assignOf(ok.state)?.retry), '123456');
      const done = step(
        ok.state,
        {
          type: 'assign.bound',
          key: cmd.key,
          result: bindResultOf({ status: 'moved', bindingId: 'b1', undoUntil: at(600_000) }),
        },
        at(700),
      );
      expect(assignOf(done.state)).toMatchObject({ step: 'done', pin: null });
    },
  );
  it('a PIN typed for one pass is dropped when the scope changes to the person', () => {
    const t = tagged();
    const r = run(t.state, [300, passReadEvent()]);
    const first = assignCmd(r.cmds, 'assign.bind');
    const asked = step(
      r.state,
      failEvent(first.key, { code: 'TAG_APPROVAL_REQUIRED', status: 403 }),
      at(400),
    );
    const ok = step(asked.state, { type: 'assign.approve', pin: '123456' }, at(500));
    const cmd = assignCmd(ok.cmds, 'assign.bind');
    const done = step(
      ok.state,
      { type: 'assign.previewed', key: cmd.key, result: bindResultOf({ opensDefault: 'pass' }) },
      at(600),
    );
    expect(assignOf(done.state)?.approved).not.toBeNull();
    const same = step(done.state, { type: 'assign.scope', scope: 'pass' }, at(650));
    expect(assignOf(same.state)?.approved).not.toBeNull();
    const wide = step(done.state, { type: 'assign.scope', scope: 'user' }, at(700));
    expect(assignOf(wide.state)).toMatchObject({ scope: 'user', approved: null });
    const bind = step(wide.state, { type: 'assign.bind' }, at(800));
    expect(assignCmd(bind.cmds, 'assign.bind').body).not.toHaveProperty('approval');
  });
  it('an already-bound answer clears the approval', () => {
    const t = tagged();
    const r = run(t.state, [300, passReadEvent()]);
    const first = assignCmd(r.cmds, 'assign.bind');
    const asked = step(
      r.state,
      failEvent(first.key, { code: 'TAG_APPROVAL_REQUIRED', status: 403 }),
      at(400),
    );
    const ok = step(asked.state, { type: 'assign.approve', pin: '123456' }, at(500));
    const cmd = assignCmd(ok.cmds, 'assign.bind');
    const here = step(
      ok.state,
      {
        type: 'assign.previewed',
        key: cmd.key,
        result: bindResultOf({ status: 'already_bound' }),
      },
      at(600),
    );
    expect(assignOf(here.state)).toMatchObject({ step: 'error', approved: null });
  });
});
