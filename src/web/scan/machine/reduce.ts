/**
 * The scan machine: one pure reducer for both postures (AC 3, SA 7.5).
 * `reduce(state, event, { now, id }) -> { state, cmds }`. Time and ids come in; nothing is read here.
 */
import { pruneIgnore } from './ignore.ts';
import type { Env, MachineState } from './internal.ts';
import { same } from './internal.ts';
import { answer, fail } from './reduce-answer.ts';
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
import type { ReduceResult, ScanEvent, ScanMachineDeps, ScanState } from './types.ts';

export function reduce(state: ScanState, event: ScanEvent, deps: ScanMachineDeps): ReduceResult {
  const env: Env = deps;
  const ignore = pruneIgnore(state.ignore, deps.now);
  const s: MachineState = ignore === state.ignore ? state : { ...state, ignore };
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
    // Desk regions arrive with CC.6: the picker, review, confirm, cancel, amount and approval.
    case 'pick':
    case 'amount':
    case 'review':
    case 'confirm':
    case 'cancel':
    case 'approve':
    case 'offline':
      return same(s);
    default:
      return setter(s, event, env) ?? same(s);
  }
}
