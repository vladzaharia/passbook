import { describe, expect, it } from 'vitest';
import { channelsManifestIssues } from '../../../../passkit/template/channels.ts';
import { generatedSource } from '../sync.ts';
import { buildKey } from './hash.ts';

const DOOR = [
  'starter-event-ticket',
  'starter-timed-ticket',
  'starter-day-pass',
  'starter-guest-pass',
  'starter-boarding-pass',
  'starter-transit-ticket',
  'starter-booking',
  'starter-poster-generic',
  'starter-permit',
];
const MEMBER = [
  'starter-monthly-pass',
  'starter-access-card',
  'starter-id-card',
  'henrys-blue',
  'henrys-copper',
];
const LOYALTY = ['starter-store-card', 'starter-stamp-card', 'starter-pack', 'starter-generic'];
const OFFER = ['starter-coupon', 'starter-pickup'];

const expected: Record<string, { paper: string; nfc: string }> = {};
for (const s of DOOR) expected[s] = { paper: 'on', nfc: 'on' };
for (const s of MEMBER) expected[s] = { paper: 'off', nfc: 'on' };
for (const s of LOYALTY) expected[s] = { paper: 'off', nfc: 'off' };
for (const s of OFFER) expected[s] = { paper: 'on', nfc: 'off' };

describe('baked template channel defaults', () => {
  it('cover every baked template with the agreed matrix and nothing for the wallets', () => {
    for (const [slug, want] of Object.entries(expected)) {
      const t = generatedSource.templates.find((x) => x.slug === slug);
      expect(t?.manifest.channels, slug).toEqual(want);
    }
    for (const t of generatedSource.templates) {
      if (expected[t.slug]) expect(channelsManifestIssues(t.manifest), t.slug).toEqual([]);
    }
  });

  it('do not change the Apple build key', async () => {
    for (const t of generatedSource.templates.filter((x) => expected[x.slug])) {
      const { channels: _channels, ...rest } = t.manifest;
      const input = { passJson: t.passJson, assets: [] };
      expect(await buildKey({ ...input, manifest: t.manifest }), t.slug).toBe(
        await buildKey({ ...input, manifest: rest }),
      );
    }
  });
});
