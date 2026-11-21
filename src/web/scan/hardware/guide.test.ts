import { describe, expect, it } from 'vitest';
import { hardwareCase } from './fixtures.test-support.ts';
import { guideOf } from './guide.ts';
import { hardwareItems } from './items.ts';

const steps = (c: Parameters<typeof hardwareCase>[0], camera = true) => {
  const { probe, live } = hardwareCase(c);
  return guideOf(hardwareItems(probe, live), { reads: live.reads, camera });
};

describe('how to scan here', () => {
  it('puts the built-in reader first, then NFC, then the camera', () => {
    expect(steps('android')).toEqual(['reader', 'nfc', 'camera']);
  });
  it('drops NFC that is off', () => {
    expect(steps('nfc-off')).toEqual(['reader', 'camera']);
  });
  it('adds the handheld scanner once one is seen', () => {
    expect(steps('wedge')).toEqual(['camera', 'handheld']);
  });
  it('falls back when nothing can read', () => {
    expect(steps('denied')).toEqual(['none']);
    expect(steps('allowed', false)).toEqual(['none']);
  });
  it('gives a monitor no steps', () => {
    const { probe, live } = hardwareCase('allowed');
    expect(guideOf(hardwareItems(probe, live), { reads: false, camera: false })).toEqual([]);
  });
});
