import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { EVENT_MANIFEST, EVENT_PASS } from '@/passkit/template/paper-fixtures.ts';
import type { EffectiveChannels } from '@/shared/contracts/channels.ts';
import { ChannelPreviews } from './channel-previews.tsx';
import type { PreviewSource } from './types.ts';

const on = { on: true, source: 'template' as const };
const channels = (over: Partial<EffectiveChannels>): EffectiveChannels => ({
  mobile: on,
  apple: on,
  google: on,
  samsung: on,
  paper: on,
  nfc: on,
  ...over,
});

const source: PreviewSource = {
  passJson: EVENT_PASS as unknown as Record<string, unknown>,
  assetBaseUrl: 'http://localhost/assets',
  assetNames: [],
  manifest: EVENT_MANIFEST as unknown as Record<string, unknown>,
  assets: [],
  input: {},
};

const show = (props: Partial<Parameters<typeof ChannelPreviews>[0]> = {}) =>
  render(
    <ChannelPreviews
      source={source}
      apple={<div data-testid="apple-pane" />}
      paper={<div data-testid="paper-pane" />}
      {...props}
    />,
  );

describe('ChannelPreviews', () => {
  it('offers all five channels with sample data and shows Apple first', () => {
    show();
    const names = screen.getAllByRole('radio').map((r) => r.textContent);
    expect(names).toEqual(['Apple', 'Google', 'Samsung', 'Mobile', 'Paper']);
    expect(screen.getByTestId('apple-pane')).toBeInTheDocument();
  });

  it('on a pass shows only the channels that are on and lists the others with why', () => {
    show({
      channels: channels({
        google: { on: false, source: 'pass', reason: 'pass_off' },
        paper: { on: false, source: 'org', reason: 'printing_off' },
      }),
    });
    expect(screen.getAllByRole('radio').map((r) => r.textContent)).toEqual([
      'Apple',
      'Samsung',
      'Mobile',
    ]);
    const list = screen.getByRole('region', { name: 'Off for this pass' });
    expect(list).toHaveTextContent('Google Wallet: off for this pass');
    expect(list).toHaveTextContent('Paper: printing off for all organizations');
  });

  it('says so when no channel is on', () => {
    const off = { on: false, source: 'pass' as const, reason: 'pass_off' as const };
    show({
      channels: channels({ apple: off, google: off, samsung: off, mobile: off, paper: off }),
    });
    expect(screen.getByText('No channel is on. This pass cannot be used.')).toBeInTheDocument();
  });

  it('compiles Google and Samsung from the pass and lists what they leave out', async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole('radio', { name: 'Google' }));
    const google = await screen.findByTestId('google-preview', undefined, { timeout: 10_000 });
    expect(google).toHaveTextContent('Spring Concert');
    expect(screen.getByTestId('fidelity-notes')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Samsung' }));
    // The fixture has no logo, and Samsung needs one for its app link: no card, the reason instead.
    await waitFor(() =>
      expect(screen.getByText('Samsung Wallet cannot show this pass.')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('samsung-preview')).toBeNull();
  }, 20_000);

  it('hands Paper to the caller, so its design can change without the switcher', async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole('radio', { name: 'Paper' }));
    expect(screen.getByTestId('paper-pane')).toBeInTheDocument();
  });
});
