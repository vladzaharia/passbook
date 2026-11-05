import { describe, expect, it } from 'vitest';
import { FIXTURE_NOW } from '../machine/fixture-data.test-support.ts';
import type { ScanEvent } from '../machine/types.ts';
import { createBus } from './bus.ts';

function make() {
  const events: ScanEvent[] = [];
  let n = 0;
  const bus = createBus({
    dispatch: (e) => events.push(e),
    clock: { now: () => FIXTURE_NOW + n * 10 },
    ids: { id: () => `01900000-0000-7000-8000-${(++n).toString(16).padStart(12, '0')}` },
    origins: ['https://passbook.mobile'],
  });
  return { bus, events };
}

describe('input bus', () => {
  it('normalizes a read, stamps id, time and signature, and dispatches it', () => {
    const { bus, events } = make();
    bus.emit({ method: 'wedge', code: ' ABC123\r' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'read',
      input: {
        method: 'wedge',
        code: 'ABC123',
        sig: 'c:ABC123',
        id: '01900000-0000-7000-8000-000000000001',
        at: FIXTURE_NOW + 10,
      },
    });
  });

  it('marks our /p/ link as a local refusal and still dispatches it (so it looks like any refusal)', () => {
    const { bus, events } = make();
    bus.emit({ method: 'camera', code: 'https://passbook.mobile/p/abc', format: 'qr' });
    expect(events[0]).toMatchObject({ type: 'read', input: { local: 'add_link' } });
  });

  it('carries the camera format and box, and a picked row', () => {
    const { bus, events } = make();
    const box = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ] as const;
    bus.emit({ method: 'camera', code: 'X1', format: 'qr', box });
    bus.emit({ method: 'manual', passId: 'p1' });
    expect(events[0]).toMatchObject({ input: { format: 'qr', box } });
    expect(events[1]).toMatchObject({ input: { passId: 'p1', sig: 'p:p1', method: 'manual' } });
  });
});
