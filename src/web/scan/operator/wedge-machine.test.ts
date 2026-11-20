import { describe, expect, it } from 'vitest';
import { states } from '../machine/fixtures.test-support.ts';
import { readOf, step } from '../machine/reduce.test-support.ts';

/**
 * The other half of rule 1: a scan that lands in the workspace goes through the same machine in
 * every state. Whatever the loop is doing, a different code is sent, queued behind the current
 * request or held for Switch / Keep. None is dropped.
 */
const CODE = 'ZZZZ9999';
const CASES: [string, () => ReturnType<typeof states.ready>][] = [
  ['ready', () => states.ready()],
  ['paused (idle)', () => states.paused('idle')],
  ['paused (hidden)', () => states.paused('hidden')],
  ['checking', () => states.checking()],
  ['checking over a card', () => states.checkingOverCard()],
  ['member', () => states.member()],
  ['picking an amount', () => states.picking()],
  ['holding another pass', () => states.held()],
  ['reviewing', () => states.reviewing()],
  ['asking for a Manager PIN', () => states.approval()],
  ['applying', () => states.applying()],
  ['accepted', () => states.verdict('ok')],
  ['refused', () => states.verdict('refused', 'voided')],
  ['held for a Manager', () => states.verdict('refused', 'needs_approval')],
];

describe('a wedge read in every machine state', () => {
  for (const [name, make] of CASES) {
    it(`${name}: the code is sent, queued or held`, () => {
      const { state, cmds } = step(make(), readOf(CODE, { method: 'wedge' }));
      const sent = cmds.some((c) => 'input' in c && c.input.code === CODE);
      const kept = JSON.stringify(state.loop).includes(`"${CODE}"`);
      expect(sent || kept).toBe(true);
    });
  }
});
