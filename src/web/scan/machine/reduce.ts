/**
 * The scan machine: one pure reducer for both postures (AC 3, SA 7.5).
 * `reduce(state, event, { now, id }) -> { state, cmds }`. Time and ids come in; nothing is read here.
 */
import { isAccessEvent, type MachineEvent } from './access-events.ts';
import { isAssignEvent } from './assign-state.ts';
import { bundleKnown, isBundleEvent } from './bundle-peek.ts';
import { pruneIgnore } from './ignore.ts';
import type { Env, MachineState, Out } from './internal.ts';
import { same } from './internal.ts';
import { resolved, turn } from './reduce-access.ts';
import { pick } from './reduce-action.ts';
import { answer, fail } from './reduce-answer.ts';
import { assignRead, cancel as cancelAssign } from './reduce-assign.ts';
import { amount, approve, cancel, confirm, value } from './reduce-desk.ts';
import {
  arm,
  disarm,
  dismiss,
  groupAll,
  keepHeld,
  override,
  switchHeld,
  undo,
  undone,
} from './reduce-door.ts';
import { openRequest } from './reduce-enroll.ts';
import { camera, resume, setter, start, visible } from './reduce-env.ts';
import { read, readFate } from './reduce-read.ts';
import { assignEvent } from './reduce-tags.ts';
import { tick } from './reduce-tick.ts';
import type { ReduceResult, ScanMachineDeps, ScanState } from './types.ts';

export function reduce(state: ScanState, event: MachineEvent, deps: ScanMachineDeps): ReduceResult {
  const env: Env = deps;
  const ignore = pruneIgnore(state.ignore, deps.now);
  const s: MachineState = ignore === state.ignore ? state : { ...state, ignore };
  const result = step(s, event, env);
  // An admin's request opens the moment the scanner has nothing else on it.
  const next = openRequest(result.state, env);
  return next.cmds.length === 0 && next.state === result.state
    ? result
    : { state: next.state, cmds: [...result.cmds, ...next.cmds] };
}

function step(s: MachineState, event: MachineEvent, env: Env): Out {
  if (isAssignEvent(event)) return assignEvent(s, event, env);
  if (isBundleEvent(event)) return bundleKnown(s, event, env.now);
  if (isAccessEvent(event))
    return event.type === 'turn' ? turn(s, event, env) : resolved(s, event, env);
  switch (event.type) {
    case 'start':
      return start(s, env);
    case 'camera':
      return camera(s, event, env);
    case 'read':
      return readFate(s, event.input, env.now) === 'assign'
        ? assignRead(s, event.input, env)
        : read(s, event.input, env);
    case 'answer':
      return answer(s, event, env);
    case 'fail':
      return fail(s, event, env);
    case 'resume':
      return resume(s, env);
    case 'visible':
      return visible(s, event, env);
    case 'online':
      // "No connection" was true when it was shown; back online, it only blocks the next scan.
      if (
        event.online &&
        s.loop.s === 'verdict' &&
        s.loop.outcome.local &&
        s.loop.outcome.kind === 'system' &&
        s.loop.outcome.reason === 'network'
      )
        return dismiss({ ...s, online: true }, env);
      return setter(s, event, env) ?? same(s);
    case 'dismiss':
      return s.assign ? cancelAssign(s, env) : dismiss(s, env);
    case 'override':
      return override(s, event, env);
    case 'group':
      return groupAll(s, env);
    case 'arm':
      return arm(s, event, env);
    case 'disarm':
      return disarm(s, env);
    case 'undo':
      return undo(s, event, env);
    case 'undone':
      return undone(s, event, env);
    case 'switch':
      return switchHeld(s, env);
    case 'keep':
      return keepHeld(s);
    case 'tick':
      return tick(s, env);
    case 'pick':
      return pick(s, event, env);
    case 'amount':
      return amount(s, event, env);
    case 'value':
      return value(s, event, env);
    case 'confirm':
      return confirm(s, env);
    case 'cancel':
      return cancel(s, env);
    case 'approve':
      return approve(s, event, env);
    // The picker is the review: its consequence line shows before and after.
    case 'review':
      return same(s);
    // The offline controller's verdict is the answer to the read it was asked about.
    case 'offline':
      return answer(s, { type: 'answer', key: event.key, outcome: event.outcome }, env);
    default:
      return setter(s, event, env) ?? same(s);
  }
}
