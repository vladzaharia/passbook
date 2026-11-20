import { describe, expect, it } from 'vitest';
import { fakeClock } from '../machine/store.test-support.ts';
import { QuietGate } from './keys-gate.ts';

const setup = () => {
  const clock = fakeClock();
  return { clock, gate: new QuietGate(clock, 80) };
};

describe('QuietGate', () => {
  it('runs a lone key once the gap has passed', () => {
    const { clock, gate } = setup();
    const ran: string[] = [];
    expect(gate.printable()).toBe('single');
    gate.defer(() => ran.push('o'));
    clock.advance(79);
    expect(ran).toEqual([]);
    clock.advance(1);
    expect(ran).toEqual(['o']);
  });

  it('drops a key that has company inside the gap, and every one after it', () => {
    const { clock, gate } = setup();
    const ran: string[] = [];
    gate.printable();
    gate.defer(() => ran.push('first'));
    clock.advance(10);
    expect(gate.printable()).toBe('burst');
    clock.advance(10);
    expect(gate.printable()).toBe('burst');
    clock.advance(200);
    expect(ran).toEqual([]);
  });

  it('a person typing slower than the gap is a series of singles', () => {
    const { clock, gate } = setup();
    expect(gate.printable()).toBe('single');
    clock.advance(120);
    expect(gate.printable()).toBe('single');
  });

  it('an Enter behind a run of fast keys ends a scan; behind one or two it is the person', () => {
    const { clock, gate } = setup();
    for (let i = 0; i < 4; i += 1) {
      gate.printable();
      clock.advance(10);
    }
    expect(gate.terminates()).toBe(true);
    clock.advance(500);
    gate.printable();
    clock.advance(20);
    gate.printable();
    clock.advance(20);
    expect(gate.terminates()).toBe(false);
  });

  it('an Enter long after the keys is the primary action', () => {
    const { clock, gate } = setup();
    for (let i = 0; i < 5; i += 1) {
      gate.printable();
      clock.advance(10);
    }
    clock.advance(300);
    expect(gate.terminates()).toBe(false);
  });

  it('cancel stops a pending key', () => {
    const { clock, gate } = setup();
    const ran: string[] = [];
    gate.printable();
    gate.defer(() => ran.push('x'));
    gate.cancel();
    clock.advance(500);
    expect(ran).toEqual([]);
  });
});
