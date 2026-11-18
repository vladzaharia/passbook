/**
 * The assign loop (UX 3.2), modelled on the desk's value regions: one small state beside the
 * loop, driven by events, asking the runner for the calls. Tag first, then the pass, then the
 * choice. Nothing here reads a clock or makes an id.
 */

import { SCAN_TAG_COPY } from '../../../shared/copy/scan-tags.ts';
import { WEDGE_UID } from '../assign/tag-reader.ts';
import type { TagRead } from '../assign/types.ts';
import type { ScanInput } from '../input/types.ts';
import {
  ASSIGN_TIMING,
  type AssignCmd,
  type AssignEvent,
  type AssignState,
  asCmd,
  type BindBodyIn,
  type CardRef,
} from './assign-state.ts';
import type { Env, MachineState, Out } from './internal.ts';
import { out, same } from './internal.ts';
import { toReady } from './reduce-door.ts';
import type { Cmd } from './types.ts';

type Of<T extends AssignEvent['type']> = Extract<AssignEvent, { type: T }>;

export const fresh = (source: AssignState['source'], now: number): AssignState => ({
  source,
  step: 'tag',
  busy: null,
  key: null,
  tag: null,
  inspected: null,
  card: null,
  preview: null,
  scope: 'pass',
  label: '',
  banner: null,
  note: null,
  error: null,
  result: null,
  request: null,
  waiting: false,
  pin: null,
  idleAt: now + ASSIGN_TIMING.IDLE,
  retry: null,
});

/** The pass is known from the start: a result card's Add tag, or an admin's request. */
export const passKnown = (a: AssignState) => a.source === 'card' || a.source === 'request';

export const cardOf = (input: ScanInput): CardRef =>
  input.passId
    ? { passId: input.passId, method: 'manual' }
    : {
        code: input.code ?? '',
        method:
          input.method === 'camera' || input.method === 'wedge' || input.method === 'nfc'
            ? input.method
            : 'manual',
      };

/** Commits a new assign state; every input pushes the idle time-out. */
export function put(s: MachineState, a: AssignState, env: Env, cmds: Cmd[] = []): Out {
  const idleAt = a.source === 'request' ? a.idleAt : env.now + ASSIGN_TIMING.IDLE;
  return out(
    {
      ...s,
      assign: { ...a, idleAt },
      assignStrip: null,
      // A row picked in Look up closes the sheet it came from.
      overlay: s.overlay === 'lookup' || s.overlay === 'camera' ? null : s.overlay,
      lastActivity: env.now,
    },
    cmds,
  );
}

const send = (cmd: AssignCmd): Cmd => asCmd(cmd);

/** Opens the assign card. The loop returns to ready first; a result card is tucked away. */
export function open(s: MachineState, ev: Of<'assign.open'>, env: Env): Out {
  const l = s.loop;
  if (s.block || !s.started || l.s === 'checking' || l.s === 'applying') return same(s);
  if (!s.online)
    return out(s, [{ c: 'announce', text: SCAN_TAG_COPY.needsConnection, polite: false }]);
  const ready = l.s === 'ready' ? out(s) : l.s === 'paused' ? out(s) : toReady(s, env);
  const base: MachineState = {
    ...ready.state,
    loop: l.s === 'paused' ? { s: 'ready', since: env.now, hint: 0 } : ready.state.loop,
    pausedReason: undefined,
    card: null,
    overlay: null,
  };
  const cmds: Cmd[] = [...ready.cmds];
  if (l.s === 'paused')
    cmds.push({ c: 'camera', op: s.released || s.camera === 'off' ? 'start' : 'resume' });
  let a = fresh(ev.from, env.now);
  if (ev.from === 'card') a = { ...a, card: ev.card };
  if (ev.from === 'unknown_tag')
    a = { ...a, tag: { read: ev.tag, sig: ev.sig }, step: 'pass', inspected: null };
  cmds.push({ c: 'beat', beat: 'pair' }, { c: 'focus', target: 'card-heading' });
  return put(base, a, env, cmds);
}

/** Sends the preview of `card` for the tag held. */
export function preview(s: MachineState, a: AssignState, card: CardRef, env: Env): Out {
  if (!a.tag) return same(s);
  const key = env.id();
  const body: BindBodyIn = { tag: a.tag.read, card, preview: true, binding: 'pass' };
  const cmd: AssignCmd = { c: 'assign.bind', key, body };
  return put(s, { ...a, card, key, busy: 'preview', banner: null, retry: cmd }, env, [send(cmd)]);
}

/** A read while the assign card is open. */
export function assignRead(s: MachineState, input: ScanInput, env: Env): Out {
  const a = s.assign;
  if (!a) return same(s);
  const { now } = env;
  // A USB reader types the tag's ID like a barcode: at the tag step an ID-shaped code is the tag.
  const typed =
    !input.tag &&
    (a.step === 'tag' || a.step === 'error') &&
    input.method === 'wedge' &&
    input.code !== undefined &&
    WEDGE_UID.test(input.code)
      ? ({ uid: input.code.toLowerCase(), tech: 'unknown', source: 'native' } satisfies TagRead)
      : undefined;
  const tag: TagRead | undefined = input.tag ?? typed;
  const noting = (kind: 'is_pass' | 'is_tag'): Out =>
    put(s, { ...a, note: { kind, until: now + ASSIGN_TIMING.NOTE } }, env);
  if (a.busy) return same(s);
  if (tag) {
    if (a.step === 'pass') return noting('is_tag');
    if (a.step === 'confirm' || a.step === 'done') return same(s);
    const empty = !tag.uid && !tag.ndef;
    const next: AssignState = {
      ...a,
      step: 'tag',
      tag: { read: tag, sig: typed ? `t:${typed.uid}` : input.sig },
      error: null,
      note: null,
      waiting: false,
    };
    if (empty)
      return put(
        s,
        { ...next, step: 'error', error: { kind: 'unreadable', web: tag.source === 'webnfc' } },
        env,
        [
          { c: 'sound', tone: 'refused' },
          { c: 'beat', beat: 'shake' },
        ],
      );
    const key = env.id();
    if (a.source === 'request' && a.request) {
      const cmd: AssignCmd = {
        c: 'enroll.complete',
        key,
        id: a.request.id,
        tag,
        request: a.request,
      };
      return put(s, { ...next, key, busy: 'complete', retry: cmd }, env, [
        { c: 'beat', beat: 'look' },
        { c: 'announce', text: 'Tag read.', polite: true },
        send(cmd),
      ]);
    }
    const cmd: AssignCmd = { c: 'assign.inspect', key, tag };
    return put(s, { ...next, key, busy: 'inspect', retry: cmd }, env, [
      { c: 'beat', beat: 'look' },
      { c: 'announce', text: 'Tag read.', polite: true },
      send(cmd),
    ]);
  }
  if (a.step === 'tag' || a.step === 'error') return noting('is_pass');
  if (a.step !== 'pass') return same(s);
  if (input.local)
    return put(s, { ...a, banner: 'not_found', note: null }, env, [{ c: 'beat', beat: 'shake' }]);
  return preview(s, { ...a, note: null }, cardOf(input), env);
}

/** Leaves the assign card. `strip` is what the strip under the card says. */
export function close(
  s: MachineState,
  env: Env,
  strip: MachineState['assignStrip'],
  cmds: Cmd[] = [],
): Out {
  const request =
    s.tagRequest && s.assign?.request?.id === s.tagRequest.request.id ? null : s.tagRequest;
  return out(
    { ...s, assign: null, assignStrip: strip ?? null, tagRequest: request, lastActivity: env.now },
    cmds,
  );
}

export function cancel(s: MachineState, env: Env): Out {
  const a = s.assign;
  if (!a) return same(s);
  if (a.step === 'done' && a.result)
    return close(s, env, {
      kind: 'assigned',
      at: env.now,
      name: a.result.card.holderName ?? a.result.card.title,
      ...(a.result.bindingId ? { bindingId: a.result.bindingId } : {}),
      undoUntil: a.result.undoUntil,
    });
  if (a.source === 'request' && a.request)
    return close(s, env, { kind: 'requestCancelled', at: env.now }, [
      send({ c: 'enroll.decline', id: a.request.id }),
    ]);
  return close(s, env, { kind: 'cancelled', at: env.now });
}

export function back(s: MachineState, env: Env): Out {
  const a = s.assign;
  if (a?.step !== 'confirm' || a.busy) return same(s);
  const known = passKnown(a);
  return put(
    s,
    {
      ...a,
      step: known ? 'tag' : 'pass',
      tag: known ? null : a.tag,
      card: known ? a.card : null,
      preview: null,
      inspected: known ? null : a.inspected,
      scope: 'pass',
      label: '',
      pin: null,
    },
    env,
    [{ c: 'focus', target: 'card-heading' }],
  );
}

/** Assign another (nothing kept) or Try another tag (a known pass kept). */
export function again(s: MachineState, ev: Of<'assign.again'>, env: Env): Out {
  const a = s.assign;
  if (!a || a.busy) return same(s);
  const keep = ev.keepPass && passKnown(a);
  const base = fresh(keep ? a.source : 'menu', env.now);
  return put(s, { ...base, card: keep ? a.card : null, request: keep ? a.request : null }, env, [
    { c: 'beat', beat: 'pair' },
    { c: 'focus', target: 'card-heading' },
  ]);
}
