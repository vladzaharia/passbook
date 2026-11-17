import { describe, expect, it } from 'vitest';
import { deepFreeze } from './freeze.ts';
import type { ScanActor } from './guard.ts';
import { scanEpochsOf, setScanEpochs } from './scan-epochs.ts';

describe('deepFreeze', () => {
  it("freezes the actor's epochs, held under a symbol key", () => {
    const actor = { orgId: 'o', event: { id: 'e' } } as unknown as ScanActor;
    setScanEpochs(actor, { scanner: { id: 's', credential: 1, config: 1 }, events: { e: 1 } });
    deepFreeze(actor);
    const epochs = scanEpochsOf(actor);
    expect(Object.isFrozen(actor)).toBe(true);
    expect(Object.isFrozen(epochs)).toBe(true);
    expect(Object.isFrozen(epochs?.events)).toBe(true);
    expect(Object.isFrozen(epochs?.scanner)).toBe(true);
    expect(() => {
      (epochs as { events: Record<string, number> }).events.e = 2;
    }).toThrow(TypeError);
  });

  it('reaches the children of an object that was already frozen, and survives cycles and typed arrays', () => {
    const child = { n: 1 };
    const parent: Record<string, unknown> = Object.freeze({ child, bytes: new Uint8Array(2) });
    const loop: Record<string, unknown> = { child };
    loop.self = loop;
    deepFreeze(parent);
    deepFreeze(loop);
    expect(Object.isFrozen(child)).toBe(true);
    expect(Object.isFrozen(loop)).toBe(true);
  });
});
