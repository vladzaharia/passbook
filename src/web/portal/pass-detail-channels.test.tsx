import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EffectiveChannels } from '@/shared/contracts/channels.ts';
import { json, renderApp } from '../lib/test-utils.tsx';
import { passFixture } from './fixtures.ts';

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const on = { on: true, source: 'template' } as const;
const off = { on: false, source: 'pass', reason: 'pass_off' } as const;
const channels = (over: Partial<EffectiveChannels>): EffectiveChannels => ({
  mobile: on,
  apple: on,
  google: { on: false, source: 'platform', reason: 'not_released' },
  samsung: { on: false, source: 'platform', reason: 'not_released' },
  paper: { on: false, source: 'platform', reason: 'printing_off' },
  nfc: { on: false, source: 'org', reason: 'tags_off' },
  ...over,
});

async function open(over: Parameters<typeof passFixture>[0]) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(MAC);
  await renderApp('/passes/p1', {
    handlers: { '/api/v1/me/passes/p1': () => json(passFixture(over)) },
  });
  await screen.findByRole('heading', { name: 'Membership', level: 1 });
}

describe('pass detail by channel', () => {
  it('drops the Apple badge while Apple is off and keeps the browser barcode', async () => {
    await open({ channels: channels({ apple: off }) });
    expect(screen.queryByRole('link', { name: 'Add to Apple Wallet' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Show barcode' })).toBeVisible();
  });

  it('drops the barcode link while mobile is off', async () => {
    await open({ channels: channels({ mobile: off }) });
    expect(screen.queryByRole('link', { name: 'Show barcode' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Add to Apple Wallet' })).toBeVisible();
  });

  it('links Print when paper is on and the holder may print', async () => {
    await open({
      channels: channels({ paper: { on: true, source: 'pass' } }),
      holderPrint: true,
    });
    expect(screen.getByRole('link', { name: 'Print' })).toHaveAttribute(
      'href',
      expect.stringMatching(/\/p\/abcdefghijklmnopqrst\/print$/),
    );
  });

  it('says no ticket is available when nothing is on', async () => {
    await open({ channels: channels({ apple: off, mobile: off }) });
    expect(screen.getByText('No ticket available. Contact Henrys.')).toBeVisible();
  });
});
