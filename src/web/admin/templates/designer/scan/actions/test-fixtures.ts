import { applyOp, type Op } from '../../apply.ts';
import { sampleDoc } from '../../fixtures.ts';
import { newInput } from '../../inputs.ts';
import type { DesignDoc } from '../../model.ts';

/** The sample template with a number, two date-times, a choice and a yes/no input. */
export function docWithInputs(): DesignDoc {
  const ops: Op[] = [
    { op: 'input-add', spec: { ...newInput([], 'number'), name: 'balance', label: 'Balance' } },
    { op: 'input-add', spec: { ...newInput([], 'datetime'), name: 'starts', label: 'Starts' } },
    { op: 'input-add', spec: { ...newInput([], 'datetime'), name: 'ends', label: 'Ends' } },
    {
      op: 'input-add',
      spec: { ...newInput([], 'choice'), name: 'tier', label: 'Tier' },
    },
    { op: 'input-add', spec: { ...newInput([], 'boolean'), name: 'paused', label: 'Paused' } },
  ];
  return ops.reduce(applyOp, sampleDoc());
}
