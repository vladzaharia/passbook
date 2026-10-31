import { describe, expect, it } from 'vitest';
import { writeEvent } from './analytics.ts';
import { createLogger } from './log.ts';

describe('writeEvent', () => {
  it('writes blobs, index and value', () => {
    const points: unknown[] = [];
    const EVENTS = { writeDataPoint: (p: unknown) => points.push(p) } as AnalyticsEngineDataset;
    writeEvent({ EVENTS }, { event: 'pass.issued', orgId: 'o1', value: 3 });
    expect(points[0]).toMatchObject({ indexes: ['o1'], doubles: [3] });
  });

  it('logs a coded warning when the write throws', () => {
    const lines: string[] = [];
    const log = createLogger({}, { sink: (line) => lines.push(line) });
    const EVENTS = {
      writeDataPoint: () => {
        throw new Error('too many data points');
      },
    } as unknown as AnalyticsEngineDataset;
    expect(() => writeEvent({ EVENTS }, { event: 'push.result', orgId: 'o1' }, log)).not.toThrow();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      event: 'analytics.write_failed',
      code: 'AE_WRITE',
    });
  });
});
