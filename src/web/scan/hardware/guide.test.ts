import { describe, expect, it } from 'vitest';
import { HARDWARE_COPY as C } from './copy.ts';
import { hardwareCase, liveFixture, probeFixture } from './fixtures.test-support.ts';
import { panelRows } from './guide.ts';
import { hardwareItems } from './items.ts';

const rows = (c: Parameters<typeof hardwareCase>[0], camera = true) => {
  const { probe, live } = hardwareCase(c);
  return panelRows(hardwareItems(probe, live), { reads: live.reads, camera });
};
const how = (r: ReturnType<typeof rows>) => r.filter((i) => i.how).map((i) => [i.name, i.how]);

describe('instructions on each way to scan', () => {
  it('orders ways to scan best first, each with its line, and marks the best', () => {
    const r = rows('android');
    expect(how(r)).toEqual([
      ['Scan engine', C.how.reader],
      ['NFC', C.how.tag],
      ['Rear camera', C.how.back],
      ['Front camera', C.how.front],
      ['Scanner', C.how.detect],
    ]);
    expect(r[0]).toMatchObject({ name: 'Scan engine', best: true });
    expect(r.filter((i) => i.best)).toHaveLength(1);
  });

  it('puts the other hardware after the ways to scan, with no lines', () => {
    const r = rows('allowed');
    const firstOther = r.findIndex((i) => i.kind === 'battery');
    expect(r.slice(0, firstOther).every((i) => i.kind === 'camera')).toBe(true);
    for (const kind of ['battery', 'screens', 'network', 'sound', 'awake'])
      expect(r.find((i) => i.kind === kind)?.how).toBeUndefined();
  });

  it('says what to do instead when a way cannot read', () => {
    expect(how(rows('denied'))[0]).toEqual(['Camera 1', C.how.allowCamera]);
    expect(rows('denied').some((i) => i.best)).toBe(false);
    expect(rows('nfc-off').find((i) => i.kind === 'nfc')?.how).toBeUndefined();
    const lost = panelRows(
      hardwareItems(probeFixture(), liveFixture({ camera: 'unavailable', activeCameraId: null })),
      { reads: true, camera: true },
    );
    expect(lost.find((i) => i.state === 'error')?.how).toBe(C.how.retry);
  });

  it('gives a seen handheld scanner its line', () => {
    expect(rows('wedge').find((i) => i.kind === 'wedge')?.how).toBe(C.how.handheld);
    expect(rows('wedge').find((i) => i.kind === 'serial')?.how).toBe(C.how.handheld);
  });

  it('gives no camera line where the view runs none, and a monitor no lines', () => {
    expect(rows('allowed', false).find((i) => i.kind === 'camera')?.how).toBeUndefined();
    const { probe, live } = hardwareCase('android');
    const monitor = panelRows(hardwareItems(probe, { ...live, reads: false }), {
      reads: false,
      camera: false,
    });
    expect(monitor.some((i) => i.how || i.best)).toBe(false);
  });

  it('tells a paused reader how to resume', () => {
    const { probe, live } = hardwareCase('android');
    const r = panelRows(hardwareItems(probe, { ...live, focused: false }), {
      reads: true,
      camera: true,
    });
    expect(r.find((i) => i.kind === 'reader')).toMatchObject({
      state: 'attention',
      status: 'Paused',
      how: C.how.paused,
    });
  });
});
