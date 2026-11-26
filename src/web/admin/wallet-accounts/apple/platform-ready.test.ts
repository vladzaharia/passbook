import { describe, expect, it } from 'vitest';
import type { PlatformIdentity } from './platform-queries.ts';
import { canMakeDefault, readiness } from './platform-ready.ts';

const row = (over: Record<string, unknown> = {}, ready: Record<string, unknown> = {}) =>
  ({
    isDefault: false,
    status: 'active',
    readiness: {
      eligible: true,
      certificate: true,
      issuing: true,
      pushHealthy: true,
      pushProbeAt: 1,
      pushProbeFresh: true,
      deviceTest: true,
      ready: true,
      ...ready,
    },
    ...over,
  }) as PlatformIdentity;

const open = (r: PlatformIdentity) =>
  readiness(r)
    .filter((c) => !c.ok)
    .map((c) => c.id);

describe('platform readiness checklist', () => {
  it('lists the server facts and names what is open', () => {
    expect(readiness(row()).map((c) => c.id)).toEqual([
      'issuing',
      'certificate',
      'push',
      'probe',
      'device',
    ]);
    expect(open(row())).toEqual([]);
    expect(open(row({}, { pushProbeFresh: false, deviceTest: false }))).toEqual([
      'probe',
      'device',
    ]);
  });

  it('leaves out a check the row is not held to', () => {
    const legacy = row(
      {},
      { issuing: null, pushHealthy: null, pushProbeFresh: null, deviceTest: null },
    );
    expect(readiness(legacy).map((c) => c.id)).toEqual(['certificate']);
  });

  it('offers Make default only to an eligible row that is not the default', () => {
    expect(canMakeDefault(row())).toBe(true);
    expect(canMakeDefault(row({ isDefault: true }))).toBe(false);
    expect(canMakeDefault(row({}, { eligible: false }))).toBe(false);
    expect(canMakeDefault(row({ status: 'retired' }))).toBe(false);
  });
});
