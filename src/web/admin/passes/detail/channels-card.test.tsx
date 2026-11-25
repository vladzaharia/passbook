import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PassDetailDto } from '@/shared/contracts/passes.ts';
import { CHANNEL_COPY } from '@/shared/copy/channels.ts';
import { json } from '@/web/lib/test-utils.tsx';
import { calls, renderTags } from '../../tags/test-fixtures.tsx';
import { ChannelsCard } from './channels-card.tsx';

const pass = (over: Record<string, unknown> = {}) =>
  ({
    id: 'p1',
    orgId: 'o1',
    status: 'active',
    removedAt: null,
    ...over,
  }) as unknown as PassDetailDto;

const on = { on: true, source: 'template' };
const off = (reason: string, source = 'template', extra = {}) => ({
  on: false,
  source,
  reason,
  ...extra,
});
const effective = (over: Record<string, unknown> = {}) => ({
  mobile: on,
  apple: on,
  google: off('not_enrolled', 'org'),
  samsung: off('not_enrolled', 'org'),
  paper: off('template_off'),
  nfc: on,
  ...over,
});
/** The chain a pass read answers with: ok down to the level the status names. */
const chainOf = (status: { on: boolean; source: string; reason?: string }) =>
  ['passbook', 'plan', 'org', 'template', 'pass'].map((level) => {
    const at = status.source === 'platform' ? 'passbook' : status.source;
    const stops = !status.on && level === at;
    return {
      level,
      state: stops ? (level === 'passbook' ? 'locked' : 'off') : 'ok',
      canChange: level !== 'passbook' && level !== 'plan',
      ...(stops ? { reason: status.reason } : {}),
    };
  });
const levelsOf = (eff: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(eff).map(([c, s]) => [c, chainOf(s as Parameters<typeof chainOf>[0])]),
  );
const handlers = (
  eff: Record<string, unknown>,
  overrides = {},
  replace: Record<string, unknown> = {
    supported: false,
    owed: false,
    blocked: null,
    lastDigital: [],
    windows: [],
  },
) => ({
  '/api/v1/passes/p1/channels': (_u: URL, init?: RequestInit) =>
    json({
      effective: eff,
      levels: levelsOf(eff),
      overrides: init?.method === 'PUT' ? {} : overrides,
      replace,
    }),
  '/api/v1/passes/p1/prints': () => json({ prints: [] }),
});
const row = (name: string) => screen.getByRole('switch', { name }).closest('li') as HTMLElement;

afterEach(() => vi.restoreAllMocks());

describe('Channels card', () => {
  it('shows state, source and why a channel cannot be switched', async () => {
    renderTags(<ChannelsCard pass={pass()} readOnly={false} />, handlers(effective()));
    await screen.findByRole('switch', { name: 'Apple Wallet' });
    expect(row('Apple Wallet')).toHaveTextContent('On');
    expect(row('Apple Wallet')).not.toHaveTextContent(CHANNEL_COPY.useTemplate);
    expect(screen.queryByRole('switch', { name: 'Google Wallet' })).toBeNull();
    expect(
      screen.getByLabelText(
        'Not available. Waiting for Google account. Copies stay as they are. Change it in Set up.',
      ),
    ).toHaveTextContent('Not available');
    expect(screen.getByRole('switch', { name: 'Paper' })).toBeEnabled();
    expect(screen.queryByText(CHANNEL_COPY.nothingOn)).toBeNull();
  });

  it('draws the chain of each channel, ringing the level that stops it', async () => {
    renderTags(<ChannelsCard pass={pass()} readOnly={false} />, handlers(effective()));
    await screen.findByRole('switch', { name: 'Apple Wallet' });
    const apple = within(row('Apple Wallet')).getByRole('list', { name: 'Chain' });
    expect(
      within(apple)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Organization', 'Template', 'This pass']);
    expect(apple.querySelector('[data-stop]')).toBeNull();
    const paper = within(row('Paper')).getByRole('list', { name: 'Chain' });
    expect(paper.querySelector('[data-stop]')).toHaveAttribute('data-level', 'template');
  });

  it('lists no channel the plan does not include or PassBook withholds', async () => {
    renderTags(
      <ChannelsCard pass={pass()} readOnly={false} />,
      handlers(
        effective({
          paper: off('not_included', 'platform'),
          nfc: off('not_included', 'platform'),
          google: off('not_released', 'platform'),
        }),
      ),
    );
    await screen.findByRole('switch', { name: 'Apple Wallet' });
    for (const name of ['Paper', 'Linked NFC', 'Google Wallet'])
      expect(screen.queryByRole('switch', { name })).toBeNull();
    expect(screen.queryByLabelText(/Not included|Not released/)).toBeNull();
    expect(screen.queryByText('PassBook')).toBeNull();
    expect(screen.queryByText('Plan')).toBeNull();
  });

  it('asks before turning a channel off, then overrides this pass only', async () => {
    const { fetchMock } = renderTags(
      <ChannelsCard pass={pass()} readOnly={false} />,
      handlers(effective()),
    );
    await userEvent.click(await screen.findByRole('switch', { name: 'Apple Wallet' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(CHANNEL_COPY.turnOffPass)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(calls(fetchMock, 'PUT', '/channels')).toHaveLength(1));
    const [, init] = calls(fetchMock, 'PUT', '/channels')[0] ?? [];
    expect(JSON.parse(String(init?.body))).toEqual({ channels: { apple: 'off' } });
  });

  it('offers new codes only when the barcode allows it, and sends replaceCodes', async () => {
    const { fetchMock } = renderTags(
      <ChannelsCard pass={pass()} readOnly={false} />,
      handlers(
        effective(),
        {},
        { supported: true, owed: true, blocked: null, lastDigital: [], windows: [] },
      ),
    );
    await userEvent.click(await screen.findByRole('switch', { name: 'Apple Wallet' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('checkbox', { name: CHANNEL_COPY.replaceBox }));
    expect(dialog).toHaveTextContent(CHANNEL_COPY.replaceNote);
    expect(dialog).not.toHaveTextContent(CHANNEL_COPY.turnOffPass);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(calls(fetchMock, 'PUT', '/channels')).toHaveLength(1));
    const [, init] = calls(fetchMock, 'PUT', '/channels')[0] ?? [];
    expect(JSON.parse(String(init?.body))).toEqual({
      channels: { apple: 'off' },
      replaceCodes: true,
    });
  });

  it('says why codes cannot be replaced, and never offers it for Paper', async () => {
    renderTags(<ChannelsCard pass={pass()} readOnly={false} />, handlers(effective()));
    await userEvent.click(await screen.findByRole('switch', { name: 'Apple Wallet' }));
    expect(await screen.findByText(CHANNEL_COPY.replaceUnsupported)).toBeInTheDocument();
  });

  it('refuses inside an open window and warns about one opening soon', async () => {
    const win = (over: Record<string, unknown>) => ({
      kind: 'event',
      id: 'e',
      name: 'Gala',
      opensAt: 1_800_000_000_000,
      closesAt: 1_800_003_600_000,
      open: false,
      scheduled: true,
      ...over,
    });
    renderTags(
      <ChannelsCard pass={pass()} readOnly={false} />,
      handlers(
        effective(),
        {},
        {
          supported: true,
          owed: true,
          blocked: { name: 'Gala', closesAt: 1_800_003_600_000 },
          lastDigital: [],
          windows: [win({ id: 'e2', name: 'Expo' })],
        },
      ),
    );
    await userEvent.click(await screen.findByRole('switch', { name: 'Apple Wallet' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('checkbox', { name: CHANNEL_COPY.replaceBox }));
    expect(dialog).toHaveTextContent("Codes can't change while Gala is open.");
    expect(within(dialog).getByRole('button', { name: 'Turn off' })).toBeDisabled();
  });

  it('turns a channel on without asking, and Use template drops an override', async () => {
    const { fetchMock } = renderTags(
      <ChannelsCard pass={pass()} readOnly={false} />,
      handlers(effective({ paper: { on: true, source: 'pass' }, apple: off('pass_off', 'pass') }), {
        paper: 'on',
        apple: 'off',
      }),
    );
    await screen.findByRole('switch', { name: 'Apple Wallet' });
    await userEvent.click(screen.getByRole('switch', { name: 'Apple Wallet' }));
    await waitFor(() => expect(calls(fetchMock, 'PUT', '/channels')).toHaveLength(1));
    await userEvent.click(
      within(row('Paper')).getByRole('button', { name: CHANNEL_COPY.useTemplate }),
    );
    await waitFor(() => expect(calls(fetchMock, 'PUT', '/channels')).toHaveLength(2));
    const [, init] = calls(fetchMock, 'PUT', '/channels')[1] ?? [];
    expect(JSON.parse(String(init?.body))).toEqual({ channels: { paper: null } });
  });

  it('shows the retired date and warns when nothing is on', async () => {
    const dead = off('template_off', 'template', { retiredAt: 1_800_000_000_000 });
    renderTags(
      <ChannelsCard pass={pass()} readOnly={false} />,
      handlers({
        mobile: dead,
        apple: dead,
        google: off('not_released', 'platform'),
        samsung: off('not_released', 'platform'),
        paper: off('template_off'),
        nfc: off('tags_off', 'org'),
      }),
    );
    expect(await screen.findByText(CHANNEL_COPY.nothingOn)).toBeInTheDocument();
  });

  it('is read-only in the other mode', async () => {
    renderTags(<ChannelsCard pass={pass()} readOnly />, handlers(effective()));
    expect(await screen.findByRole('switch', { name: 'Apple Wallet' })).toBeDisabled();
  });
});
