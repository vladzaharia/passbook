/** The tag events: the assign loop's and the admin request's. */
import { type AssignEvent, isAssignEvent } from './assign-state.ts';
import type { Env, MachineState, Out } from './internal.ts';
import { same } from './internal.ts';
import {
  again,
  applyAnswer,
  approve,
  back,
  bind,
  cancel,
  edit,
  open,
  pin,
  retry,
  undo,
} from './reduce-assign.ts';
import { arrive, cancelled, later, openRequest } from './reduce-enroll.ts';

export { isAssignEvent };

export function assignEvent(s: MachineState, ev: AssignEvent, env: Env): Out {
  const answered = applyAnswer(s, ev, env);
  if (answered) return answered;
  switch (ev.type) {
    case 'assign.open':
      return open(s, ev, env);
    case 'assign.cancel':
    case 'enroll.decline':
      return cancel(s, env);
    case 'assign.done':
      return cancel(s, env);
    case 'assign.back':
      return back(s, env);
    case 'assign.again':
      return again(s, ev, env);
    case 'assign.scope':
    case 'assign.label':
      return edit(s, ev, env);
    case 'assign.bind':
      return bind(s, ev, env);
    case 'assign.pin':
      return pin(s, ev, env);
    case 'assign.approve':
      return approve(s, ev, env);
    case 'assign.retry':
      return retry(s, env);
    case 'assign.undo':
      return undo(s, env);
    case 'enroll.arrive':
      return arrive(s, ev, env);
    case 'enroll.cancelled':
      return cancelled(s, ev, env);
    case 'enroll.later':
      return later(s);
    case 'enroll.open':
      return openRequest(s, env, true);
    default:
      return same(s);
  }
}
