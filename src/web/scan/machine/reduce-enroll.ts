/** An admin's request on this scanner (UX 5): it arrives, waits its turn, opens, or ends. */

import { scanLine } from '../../../shared/copy/scan.ts';
import { SCAN_TAG_COPY } from '../../../shared/copy/scan-tags.ts';
import type { AssignEvent } from './assign-state.ts';
import type { Env, MachineState, Out } from './internal.ts';
import { out, same } from './internal.ts';
import { close, fresh, put } from './reduce-assign.ts';
import { toReady } from './reduce-door.ts';
import type { Cmd } from './types.ts';

type Of<T extends AssignEvent['type']> = Extract<AssignEvent, { type: T }>;

/** The device can show a request now: nothing else is on the scanner. */
const idle = (s: MachineState) =>
  s.started &&
  s.block === null &&
  s.online &&
  s.overlay === null &&
  s.assign == null &&
  s.loop.s === 'ready';

export function openRequest(s: MachineState, env: Env, force = false): Out {
  const r = s.tagRequest;
  if (!r || r.opened || (r.later && !force)) return same(s);
  if (r.request.expiresAt <= env.now) return out({ ...s, tagRequest: null });
  if (!force && !idle(s)) return same(s);
  const ready = s.loop.s === 'ready' ? out(s) : toReady(s, env);
  const base: MachineState = { ...ready.state, card: null, overlay: null };
  const a = { ...fresh('request', env.now), request: r.request, idleAt: r.request.expiresAt };
  const who = scanLine(SCAN_TAG_COPY.request.strip, { name: r.request.holderName });
  return put({ ...base, tagRequest: { ...r, opened: true, later: false } }, a, env, [
    ...ready.cmds,
    { c: 'sound', tone: 'heads_up' },
    { c: 'beat', beat: 'pair' },
    {
      c: 'announce',
      text: r.request.requestedByName
        ? `${who} ${scanLine(SCAN_TAG_COPY.request.from, { admin: r.request.requestedByName })}.`
        : who,
      polite: true,
    },
    { c: 'focus', target: 'card-heading' },
  ]);
}

export function arrive(s: MachineState, ev: Of<'enroll.arrive'>, env: Env): Out {
  const { request } = ev;
  if (request.expiresAt <= env.now) return same(s);
  if (s.tagRequest?.request.id === request.id || s.assign?.request?.id === request.id)
    return same(s);
  const cmds: Cmd[] = [];
  // Someone is busy: the chip waits, and its own pulse is the cue.
  if (!idle(s)) cmds.push({ c: 'sound', tone: 'heads_up' });
  return out({ ...s, tagRequest: { request, opened: false } }, cmds);
}

/** The admin cancelled, or a reconnect found no request: what showed ends. */
export function cancelled(s: MachineState, ev: Of<'enroll.cancelled'>, env: Env): Out {
  const a = s.assign;
  if (a?.request?.id === ev.id) return close(s, env, { kind: 'adminCancelled', at: env.now });
  if (s.tagRequest?.request.id === ev.id) return out({ ...s, tagRequest: null });
  return same(s);
}

export function later(s: MachineState): Out {
  const r = s.tagRequest;
  return r && !r.opened ? out({ ...s, tagRequest: { ...r, later: true } }) : same(s);
}

/** The request times out on the device (its own timer; the server expires it lazily). */
export function expire(s: MachineState, env: Env): Out {
  const a = s.assign;
  if (a?.request && a.request.expiresAt <= env.now && a.step !== 'done')
    return close(s, env, { kind: 'requestTimedOut', at: env.now }, [
      { c: 'announce', text: SCAN_TAG_COPY.strip.requestTimedOut, polite: false },
    ]);
  const r = s.tagRequest;
  if (r && !r.opened && r.request.expiresAt <= env.now) return out({ ...s, tagRequest: null });
  return same(s);
}
