import { describe, expect, it } from 'vitest';
import type { PlatformIdentity } from './platform-queries.ts';
import { canMakeDefault, PROBE_FRESH_MS, readiness } from './platform-ready.ts';

const NOW = 1_800_000_000_000;
const row = (over: Partial<PlatformIdentity> = {}): PlatformIdentity =>
  ({
    id: 'p1',
    slot: 'root',
    purpose: 'passes',
    issuing: true,
    certSha256: 'ab',
    notAfter: NOW + 90 * 86_400_000,
    apnsHealth: 'healthy',
    apnsCheckedAt: NOW - 1000,
    registrationCount: 2,
    isDefault: false,
    status: 'active',
    ...over,
  }) as PlatformIdentity;

const open = (r: PlatformIdentity) =>
  readiness(r, NOW)
    .filter((c) => !c.ok)
    .map((c) => c.id);

describe('platform readiness', () => {
  it('is ready with issuing, certificate, healthy fresh push and a device', () => {
    expect(open(row())).toEqual([]);
  });

  it('names what is open', () => {
    expect(open(row({ issuing: false }))).toEqual(['issuing']);
    expect(open(row({ apnsHealth: 'failing' }))).toEqual(['push']);
    expect(open(row({ apnsCheckedAt: NOW - PROBE_FRESH_MS - 1 }))).toEqual(['probe']);
    expect(open(row({ apnsCheckedAt: null }))).toEqual(['probe']);
    expect(open(row({ registrationCount: 0 }))).toEqual(['device']);
    expect(open(row({ notAfter: NOW - 1 }))).toEqual(['certificate']);
  });

  it('asks the legacy identity for its certificate only', () => {
    expect(open(row({ slot: null, apnsHealth: 'unknown', registrationCount: 0 }))).toEqual([]);
    expect(open(row({ slot: null, certSha256: null }))).toEqual(['certificate']);
  });

  it('offers Make default only for a passes identity that is not the default', () => {
    expect(canMakeDefault(row())).toBe(true);
    expect(canMakeDefault(row({ isDefault: true }))).toBe(false);
    expect(canMakeDefault(row({ purpose: 'device_test' }))).toBe(false);
    expect(canMakeDefault(row({ status: 'retired' }))).toBe(false);
  });
});
