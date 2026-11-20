import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { PassDetailDto } from '@/shared/contracts/passes.ts';
import type { PassStampsDto } from '@/shared/contracts/stamps.ts';
import { resetModeForTests } from '../../../lib/mode.ts';
import { createQueryClient } from '../../../lib/query-client.ts';
import { membershipsQuery, sessionQuery } from '../../../lib/session.ts';
import {
  json,
  membershipFixture,
  problem,
  sessionFixture,
  stubFetch,
} from '../../../lib/test-utils.tsx';
import { TooltipProvider, toast } from '../../../ui/index.ts';
import { passDetail } from '../test-fixtures.ts';
import { ImagesTab } from './images-tab.tsx';
import { StampsCard } from './stamps-card.tsx';

afterEach(() => {
  resetModeForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const stamps = (over: Partial<PassStampsDto> = {}): PassStampsDto => ({
  input: 'stamps',
  goal: 10,
  count: 7,
  card: 7,
  ready: false,
  maximum: 19,
  ...over,
});

function setup(current: PassStampsDto, readOnly = false) {
  const client = createQueryClient();
  const session = sessionFixture('admin');
  if (!session.authenticated) throw new Error('Expected an authenticated fixture.');
  client.setQueryData(sessionQuery.queryKey, session);
  client.setQueryData(membershipsQuery.queryKey, {
    items: [
      membershipFixture('org1', {
        userId: session.user.id,
        capabilities: ['org:read', 'passes:read', 'passes:operate'],
      }),
    ],
  });
  const pass = passDetail({ stamps: current, mode: 'live' }) as unknown as PassDetailDto;
  const view = render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <StampsCard pass={pass} stamps={current} readOnly={readOnly} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { ...view, client, pass };
}

describe('Stamps card', () => {
  it('shows the card and what is left, with redeem off until the reward is ready', async () => {
    const { container } = setup(stamps());
    expect(screen.getByText('7 of 10')).toBeVisible();
    expect(screen.getByText('3 more for the reward.')).toBeVisible();
    expect(screen.getByRole('img', { name: /7 of 10 filled/ })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Redeem reward' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add stamp' })).toBeEnabled();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('adds a stamp through the pass API', async () => {
    const fetch = stubFetch({
      '/api/v1/passes/p1/stamps': (_url, init) => {
        expect(JSON.parse(String(init?.body))).toEqual({ action: 'add', count: 1 });
        return json(passDetail({ stamps: stamps({ count: 8, card: 8 }) }));
      },
    });
    const done = vi.spyOn(toast, 'success');
    setup(stamps());
    await userEvent.click(screen.getByRole('button', { name: 'Add stamp' }));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await waitFor(() => expect(done).toHaveBeenCalledWith('Stamp added'));
  });

  it('redeems a ready card and keeps the carry-over in view', async () => {
    stubFetch({
      '/api/v1/passes/p1/stamps': () => json(passDetail({ stamps: stamps({ count: 2, card: 2 }) })),
    });
    setup(stamps({ count: 12, card: 10, ready: true }));
    expect(screen.getByText('Reward ready')).toBeVisible();
    expect(screen.getByText('Ready to redeem. 2 saved for the next card.')).toBeVisible();
    const done = vi.spyOn(toast, 'success');
    await userEvent.click(screen.getByRole('button', { name: 'Redeem reward' }));
    await waitFor(() => expect(done).toHaveBeenCalledWith('Reward redeemed'));
  });

  it('says a full card needs a redeem, and shows a refusal', async () => {
    setup(stamps({ count: 19, card: 10, ready: true }));
    expect(screen.getByRole('button', { name: 'Add stamp' })).toBeDisabled();
    expect(screen.getByText('The card is full. Redeem the reward first.')).toBeVisible();
  });

  it('shows the server refusal', async () => {
    stubFetch({
      '/api/v1/passes/p1/stamps': () =>
        problem(409, 'PASS_CONFLICT', 'The pass changed. Reload and retry.'),
    });
    setup(stamps());
    await userEvent.click(screen.getByRole('button', { name: 'Add stamp' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The pass changed. Reload and retry.',
    );
  });

  it('is inert when the pass is read only', () => {
    setup(stamps({ count: 12, card: 10, ready: true }), true);
    expect(screen.getByRole('button', { name: 'Add stamp' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Redeem reward' })).toBeDisabled();
  });
});

describe('a stamp card on the Images tab', () => {
  const strip = { sha1: 'a', size: 10, width: 750, height: 288, createdAt: 1 };
  const renderTab = (current: PassStampsDto | null, items: unknown[]) => {
    stubFetch({ '/api/v1/passes/p1/assets': () => json({ items, nextCursor: null }) });
    const client = createQueryClient();
    const pass = passDetail({
      mode: 'live',
      stamps: current,
      passJson: { storeCard: {} },
      assetNames: ['icon@2x.png', 'strip@2x.png'],
    }) as unknown as PassDetailDto;
    render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <ImagesTab pass={pass} readOnly />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  };

  it('warns that a per-pass strip hides the stamps', async () => {
    renderTab(stamps(), [{ name: 'strip@2x.png', ...strip }]);
    expect(
      await screen.findByText('This strip hides the stamps. Remove it to show them.'),
    ).toBeVisible();
  });

  it('says nothing without an override', async () => {
    renderTab(stamps(), []);
    expect(await screen.findByText('Strip')).toBeVisible();
    expect(screen.queryByText(/hides the stamps/)).toBeNull();
  });

  it('says nothing for a custom strip on a card without stamps', async () => {
    renderTab(null, [{ name: 'strip@2x.png', ...strip }]);
    expect(await screen.findByText('Custom')).toBeVisible();
    expect(screen.queryByText(/hides the stamps/)).toBeNull();
  });
});
