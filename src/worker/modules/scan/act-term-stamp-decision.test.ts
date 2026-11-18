import { describe, expect, it } from 'vitest';
import { termInputToStamp } from './act-term-stamp.ts';

type F = Parameters<typeof termInputToStamp>[0];
const found = (over: {
  personalization?: Record<string, unknown>;
  fieldSources?: Record<string, string>;
  occupancy?: unknown;
  admission?: unknown;
  behaviors?: unknown;
}): F =>
  ({
    template: {
      manifest: {
        behaviors: over.behaviors ?? [
          { use: 'term', version: 1, config: { start: 's', startOn: 'first-scan' } },
        ],
      },
    },
    pass: { personalization: over.personalization ?? {}, fieldSources: over.fieldSources ?? {} },
    occupancy: over.occupancy,
    admission: over.admission,
  }) as unknown as F;

describe('which scan stamps a term start', () => {
  it('stamps an entry, and a scan with no direction', () => {
    expect(termInputToStamp(found({}))).toBe('s');
    expect(termInputToStamp(found({ admission: { state: { direction: 'in' } } }))).toBe('s');
    expect(termInputToStamp(found({ occupancy: { direction: 'in' } }))).toBe('s');
  });

  it('does not stamp a non-zone admission exit', () => {
    expect(termInputToStamp(found({ admission: { state: { direction: 'out' } } }))).toBeNull();
  });

  it('does not stamp a zone exit, and the place wins over the admission', () => {
    expect(termInputToStamp(found({ occupancy: { direction: 'out' } }))).toBeNull();
    expect(
      termInputToStamp(
        found({ occupancy: { direction: 'in' }, admission: { state: { direction: 'out' } } }),
      ),
    ).toBe('s');
  });

  it('does not stamp a filled, connection-owned or term-less pass', () => {
    expect(
      termInputToStamp(found({ personalization: { s: '2030-01-01T00:00:00.000Z' } })),
    ).toBeNull();
    expect(termInputToStamp(found({ fieldSources: { s: 'connection' } }))).toBeNull();
    expect(termInputToStamp(found({ behaviors: [] }))).toBeNull();
    expect(
      termInputToStamp(
        found({
          behaviors: [{ use: 'term', version: 1, config: { start: 's', startOn: 'issue' } }],
        }),
      ),
    ).toBeNull();
  });
});
