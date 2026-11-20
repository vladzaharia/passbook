import { describe, expect, it } from 'vitest';
import type { TemplateManifest } from '../types.ts';
import { channelsManifestIssues } from './channels.ts';

const m = (channels: unknown) => ({ channels }) as unknown as TemplateManifest;

describe('manifest channels block', () => {
  it('accepts on and off per known channel, or no block', () => {
    expect(channelsManifestIssues(m(undefined))).toEqual([]);
    expect(channelsManifestIssues(m({ paper: 'on', nfc: 'off', google: 'on' }))).toEqual([]);
  });

  it('refuses unknown channels, other states and other shapes', () => {
    expect(channelsManifestIssues(m({ fax: 'on' }))[0]?.code).toBe('CHANNELS_UNKNOWN');
    expect(channelsManifestIssues(m({ paper: 'never' }))[0]?.code).toBe('CHANNELS_STATE');
    expect(channelsManifestIssues(m(['paper']))[0]?.code).toBe('CHANNELS_SHAPE');
  });
});
