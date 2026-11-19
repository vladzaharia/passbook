import { describe, expect, it } from 'vitest';
import { CHANNEL_LABEL, CHANNEL_REASON_COPY, channelReason } from '../copy/channels.ts';
import {
  BulkPassChannelsSchema,
  CHANNEL_REASONS,
  CHANNELS,
  EffectiveChannelsSchema,
  PassChannelsResponseSchema,
  PutPassChannelsSchema,
  PutTemplateChannelsSchema,
  TemplateChannelStateSchema,
} from './channels.ts';

const status = { on: true, source: 'template' } as const;
const effective = Object.fromEntries(CHANNELS.map((c) => [c, status]));

describe('channel contracts', () => {
  it('has copy for every channel and reason', () => {
    for (const c of CHANNELS) expect(CHANNEL_LABEL[c]).toBeTruthy();
    for (const r of CHANNEL_REASONS) expect(CHANNEL_REASON_COPY[r]).toContain('{channel}');
    expect(channelReason('google', 'not_enrolled')).toBe(
      'Google Wallet: organization not enrolled',
    );
  });

  it('requires every channel in the effective map', () => {
    expect(EffectiveChannelsSchema.safeParse(effective).success).toBe(true);
    const { nfc: _n, ...partial } = effective;
    expect(EffectiveChannelsSchema.safeParse(partial).success).toBe(false);
    expect(
      EffectiveChannelsSchema.safeParse({
        ...effective,
        paper: { on: false, source: 'platform', reason: 'printing_off' },
      }).success,
    ).toBe(true);
    expect(
      EffectiveChannelsSchema.safeParse({ ...effective, paper: { on: false, source: 'x' } })
        .success,
    ).toBe(false);
  });

  it('allows never only on a template', () => {
    expect(TemplateChannelStateSchema.safeParse('never').success).toBe(true);
    expect(PutPassChannelsSchema.safeParse({ channels: { apple: 'never' } }).success).toBe(false);
    expect(PutTemplateChannelsSchema.parse({ channels: { paper: 'never' } }).dryRun).toBe(false);
  });

  it('accepts overrides, null resets and rejects empty or unknown channels', () => {
    const body = PutPassChannelsSchema.parse({ channels: { paper: 'on', apple: null } });
    expect(body.notify).toBe(true);
    expect(body.replaceCodes).toBe(false);
    expect(PutPassChannelsSchema.safeParse({ channels: {} }).success).toBe(false);
    expect(PutPassChannelsSchema.safeParse({ channels: { fax: 'on' } }).success).toBe(false);
    expect(
      PassChannelsResponseSchema.safeParse({ effective, overrides: { paper: 'on' } }).success,
    ).toBe(true);
  });

  it('bulk: notify defaults off, ids bounded', () => {
    const ok = BulkPassChannelsSchema.parse({ action: 'off', channels: ['apple'], ids: ['a'] });
    expect(ok.notify).toBe(false);
    expect(BulkPassChannelsSchema.safeParse({ ...ok, action: 'nope' }).success).toBe(false);
    expect(BulkPassChannelsSchema.safeParse({ ...ok, ids: [] }).success).toBe(false);
    expect(BulkPassChannelsSchema.safeParse({ ...ok, channels: [] }).success).toBe(false);
  });
});
