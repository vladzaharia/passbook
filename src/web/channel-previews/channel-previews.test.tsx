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

  const off = { on: false, source: 'template' as const, reason: 'template_off' as const };
  const gone = { on: false, source: 'org' as const, reason: 'not_enrolled' as const };
  const tab = (name: string) => screen.getByRole('radio', { name });
  const names = () => screen.getAllByRole('radio').map((r) => r.textContent);

  it('keeps a channel the template or pass turns off as a quiet tab with its reason', () => {
    show({
      channels: channels({
        google: { on: false, source: 'pass', reason: 'pass_off' },
        mobile: { on: false, source: 'template', reason: 'never' },
        paper: { on: false, source: 'template', reason: 'no_design' },
      }),
    });
    expect(names()).toEqual([
      'Apple',
      'GoogleOff for this pass',
      'Samsung',
      'MobileNever on for this template',
      'PaperNo design for this template',
    ]);
    for (const [name, text] of [
      ['Google', 'Off for this pass'],
      ['Mobile', 'Never on for this template'],
      ['Paper', 'No design for this template'],
    ] as const) {
      const t = tab(name);
      expect(t).toHaveAttribute('data-off');
      expect(t).not.toHaveAttribute('aria-disabled');
      // The tooltip chunk is not loaded here: the reason is the native title.
      expect(t).toHaveAttribute('title', text);
      expect(t).toHaveAccessibleDescription(text);
      // No lock or any other icon: the hatch says it.
      expect(t.querySelector('svg')).toBeNull();
    }
    expect(tab('Apple')).not.toHaveAttribute('data-off');
    expect(tab('Samsung')).not.toHaveAttribute('data-off');
  });

  it('has no tab for a channel PassBook, the plan or the organization stops', () => {
    show({
      channels: channels({
        google: { on: false, source: 'platform', reason: 'not_released' },
        samsung: gone,
        paper: { on: false, source: 'platform', reason: 'not_included' },
      }),
    });
    expect(names()).toEqual(['Apple', 'Mobile']);
    expect(screen.queryByRole('radio', { name: 'Google' })).toBeNull();
    expect(document.querySelector('[data-locked]')).toBeNull();
  });

  it('says Off when a channel is off without a reason', () => {
    show({ channels: channels({ google: { on: false, source: 'template' } }) });
    expect(tab('Google')).toHaveAccessibleDescription('Off');
  });

  it('opens an off tab to say why and where it turns back on, with no lock on the choice', async () => {
    const user = userEvent.setup();
    show({
      channels: channels({
        google: off,
        mobile: { on: false, source: 'pass', reason: 'pass_off' },
      }),
      lockedAction: ({ level }) => <a href="#fix">Fix at {level}</a>,
    });
    await user.click(tab('Google'));
    expect(tab('Google')).toBeChecked();
    expect(tab('Google').querySelector('svg')).toBeNull();
    const pane = screen.getByText('Google Wallet').closest('[data-locked]');
    expect(pane).toHaveAttribute('data-locked', 'template');
    expect(pane).toHaveTextContent('Off for this template');
    expect(screen.getByRole('link', { name: 'Fix at template' })).toBeInTheDocument();
    // The card stays behind the veil, greyed and hidden from assistive tech.
    expect(screen.getByTestId('apple-pane').parentElement).toHaveAttribute('aria-hidden', 'true');
    await user.click(tab('Mobile'));
    const passPane = document.querySelector('[data-locked]');
    expect(passPane).toHaveAttribute('data-locked', 'pass');
    expect(passPane).toHaveTextContent('MobileOff for this pass');
    await user.click(tab('Apple'));
    expect(screen.queryByRole('link', { name: /Fix at/ })).toBeNull();
  });

  it('arrow keys move through off tabs too', async () => {
    const user = userEvent.setup();
    show({ channels: channels({ google: off, samsung: off }) });
    tab('Apple').focus();
    await user.keyboard('{ArrowRight}');
    await waitFor(() => expect(tab('Google')).toBeChecked());
    await user.keyboard('{End}');
    await waitFor(() => expect(tab('Paper')).toBeChecked());
  });

  it('starts on the first enabled channel', () => {
    show({ channels: channels({ apple: off, google: off }) });
    expect(tab('Samsung')).toBeChecked();
  });

  it('moves the selection when the selected channel loses its tab', async () => {
    const user = userEvent.setup();
    const { rerender } = show();
    await user.click(tab('Samsung'));
    rerender(
      <ChannelPreviews
        source={source}
        apple={<div data-testid="apple-pane" />}
        paper={<div data-testid="paper-pane" />}
        channels={channels({ samsung: gone })}
      />,
    );
    expect(tab('Apple')).toBeChecked();
    expect(screen.queryByRole('radio', { name: 'Samsung' })).toBeNull();
  });

  it('moves the selection when the selected channel turns off', () => {
    const { rerender } = show();
    expect(tab('Apple')).toBeChecked();
    rerender(
      <ChannelPreviews
        source={source}
        apple={<div data-testid="apple-pane" />}
        paper={<div data-testid="paper-pane" />}
        channels={channels({ apple: off })}
      />,
    );
    expect(tab('Google')).toBeChecked();
    expect(screen.queryByTestId('apple-pane')).toBeNull();
  });

  it('shows the same tabs for a pass and a template with the same channels', () => {
    const same = channels({ apple: off, paper: gone });
    const read = () =>
      screen.getAllByRole('radio').map((r) => [r.textContent, r.hasAttribute('data-off')]);
    const pass = show({ channels: same });
    const first = read();
    pass.unmount();
    show({ channels: same, source: { ...source, testBand: false } });
    expect(read()).toEqual(first);
  });

  it('shows the empty state and its action when no channel is on', async () => {
    show({
      channels: channels({ apple: off, google: off, samsung: off, mobile: off, paper: off }),
      emptyAction: <a href="#channels">Channels</a>,
    });
    expect(await screen.findByText('No channel is on')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Channels' })).toBeInTheDocument();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
  });

  it('compiles Google and Samsung from the pass and lists what they leave out', async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole('radio', { name: 'Google' }));
    const google = await screen.findByTestId('google-preview', undefined, { timeout: 10_000 });
    expect(google).toHaveTextContent('Spring Concert');
    expect(screen.getByTestId('google-report')).toBeInTheDocument();
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
