import { describe, expect, it } from 'vitest';
import { HW_NOW, hardwareCase, liveFixture, probeFixture } from './fixtures.test-support.ts';
import { hardwareItems } from './items.ts';
import { changeOf, pillIcons, pillLabel } from './pill-model.ts';

const icons = (c: Parameters<typeof hardwareCase>[0]) => {
  const { probe, live } = hardwareCase(c);
  return pillIcons(hardwareItems(probe, live));
};

describe('the hardware pill', () => {
  it('shows only detected kinds, one icon each', () => {
    expect(icons('allowed')).toEqual([{ kind: 'camera', state: 'active' }]);
    expect(icons('wedge').map((i) => i.kind)).toEqual(['camera', 'wedge', 'serial']);
    expect(icons('android').map((i) => i.kind)).toEqual(['camera', 'reader', 'nfc']);
  });

  it('shows the battery only when it is low', () => {
    expect(icons('nfc-off').map((i) => i.kind)).toContain('battery');
    expect(icons('allowed').map((i) => i.kind)).not.toContain('battery');
  });

  it('takes the most urgent state of a kind', () => {
    expect(icons('denied')).toEqual([{ kind: 'camera', state: 'attention' }]);
  });

  it('names each icon and its state', () => {
    expect(pillLabel(icons('wedge'))).toBe('Hardware: Camera on, Scanner on, Serial on');
    expect(pillLabel([])).toBe('Hardware: No hardware found');
  });
});

describe('hardware announcements', () => {
  it('says a connect, a loss and a recovery', () => {
    const before = pillIcons(hardwareItems(probeFixture(), liveFixture()));
    const seen = liveFixture({ wedge: { seenAt: HW_NOW, badLayout: false, tracked: true } });
    const after = pillIcons(hardwareItems(probeFixture(), seen));
    expect(changeOf(before, after)).toBe('Scanner connected');
    const lost = pillIcons(hardwareItems(probeFixture(), liveFixture({ camera: 'unavailable' })));
    expect(changeOf(before, lost)).toBe('Camera lost');
    expect(changeOf(lost, before)).toBe('Camera back');
    expect(changeOf(before, before)).toBeNull();
    expect(changeOf(before, [])).toBe('Camera lost');
  });

  it('says NFC on when a tap starts it', () => {
    const idle = pillIcons(hardwareItems(probeFixture({ webNfc: true }), liveFixture()));
    const on = pillIcons(
      hardwareItems(probeFixture({ webNfc: true }), liveFixture({ webNfc: 'on' })),
    );
    expect(changeOf(idle, on)).toBe('NFC on');
  });
});
