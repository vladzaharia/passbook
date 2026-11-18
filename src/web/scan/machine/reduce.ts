/**
 * The scan machine: one pure reducer for both postures (AC 3, SA 7.5).
 * `reduce(state, event, { now, id }) -> { state, cmds }`. Time and ids come in; nothing is read here.
 */
import { isAccessEvent, type MachineEvent } from './access-events.ts';
import { pruneIgnore } from './ignore.ts';
import type { Env, MachineState } from './internal.ts';
import { same } from './internal.ts';
import { resolved, turn } from './reduce-access.ts';
import { pick } from './reduce-action.ts';
import { answer, fail } from './reduce-answer.ts';
import { amount, approve, cancel, confirm, value } from './reduce-desk.ts';
import {
  arm,
  disarm,
  dismiss,
  keepHeld,
  override,
  switchHeld,
  undo,
  undone,
} from './reduce-door.ts';
import { camera, resume, setter, start, visible } from './reduce-env.ts';
import { read } from './reduce-read.ts';
import { tick } from './reduce-tick.ts';
import type { ReduceResult, ScanMachineDeps, ScanState } from './types.ts';

export function reduce(state: ScanState, event: MachineEvent, deps: ScanMachineDeps): ReduceResult {
  const env: Env = deps;
  const ignore = pruneIgnore(state.ignore, deps.now);
  const s: MachineState = ignore === state.ignore ? state : { ...state, ignore };
  if (isAccessEvent(event))
    return event.type === 'turn' ? turn(s, event, env) : resolved(s, event, env);
  switch (event.type) {
    case 'start':
      return start(s, env);
    case 'camera':
      return camera(s, event, env);
    case 'read':
      return read(s, event.input, env);
    case 'answer':
      return answer(s, event, env);
    case 'fail':
      return fail(s, event, env);
    case 'resume':
      return resume(s, env);
    case 'visible':
      return visible(s, event, env);
    case 'dismiss':
      return dismiss(s, env);
    case 'override':
      return override(s, event, env);
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
    case 'offline':
      return same(s);
    default:
      return setter(s, event, env) ?? same(s);
  }
}
