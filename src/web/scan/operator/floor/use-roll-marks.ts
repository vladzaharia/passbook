import type { useOperator } from '../use-operator.ts';
import { nextToConfirm, rollOrder } from './floor-model.ts';
import type { Floor } from './use-floor.ts';

type Operator = ReturnType<typeof useOperator>;

/**
 * The open person on a roll call, and how to mark them. S and X answer first while a call runs; a
 * mark goes on to the next person still to confirm, a taken-back one stays put.
 */
export function useRollMarks(op: Operator, floor: Floor) {
  const call = floor.roll.call;
  const marked = op.record?.kind === 'pass' && !op.live ? op.record.passId : null;
  const person = call && marked ? call.people.find((p) => p.passId === marked) : undefined;
  const mark = (passId: string, status: 'present' | 'out' | 'none') => {
    if (!call) return;
    const next = status === 'none' ? null : nextToConfirm(rollOrder(call), passId);
    floor.roll.mark(passId, status);
    if (next) op.open(next, 'roll-call');
  };
  op.rollKeys.current = {
    open: call !== null,
    run: (command) => {
      if (!person) return false;
      const at = person.mark?.status;
      if (command.c === 'safe') mark(person.passId, at === 'present' ? 'none' : 'present');
      else if (command.c === 'gone') mark(person.passId, at === 'out' ? 'none' : 'out');
      else return false;
      return true;
    },
  };
  return { person, mark };
}
