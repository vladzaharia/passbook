import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { json, problem, renderApp } from '../lib/test-utils.tsx';
import { passFixture } from './fixtures.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const list = (...items: ReturnType<typeof passFixture>[]) => json({ items, nextCursor: null });

describe('my passes', () => {
  it('renders cards with org, wallet link and no a11y violations', async () => {
    const { container } = await renderApp('/', {
      handlers: { '/api/v1/me/passes': () => list(passFixture()) },
    });
    expect(
      await screen.findByRole('heading', { name: 'Gym membership', level: 2 }),
    ).toBeInTheDocument();
    expect(screen.getByText('Henrys', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add to Apple Wallet' })).toHaveAttribute(
      'href',
      '/p/abcdefghijklmnopqrst/pass.pkpass',
    );
    expect(screen.getByRole('link', { name: 'Gym membership' })).toHaveAttribute(
      'href',
      '/passes/p1',
    );
    expect((await axe(container)).violations).toEqual([]);
  });

  it('offers a bundle link only with two or more active passes, in chunks of 10', async () => {
    await renderApp('/', {
      handlers: { '/api/v1/me/passes': () => list(passFixture()) },
    });
    await screen.findByRole('heading', { name: 'Gym membership', level: 2 });
    expect(screen.queryByRole('link', { name: /All passes/ })).toBeNull();
  });

  it('links the bundle for two passes', async () => {
    await renderApp('/', {
      handlers: {
        '/api/v1/me/passes': () => list(passFixture(), passFixture({ id: 'p2' })),
      },
    });
    expect(await screen.findByRole('link', { name: /All passes \(2\)/ })).toHaveAttribute(
      'href',
      '/api/v1/me/passes.pkpasses?part=1',
    );
  });

  it('splits eleven passes into two bundle links', async () => {
    const many = Array.from({ length: 11 }, (_, i) => passFixture({ id: `p${i}` }));
    await renderApp('/', { handlers: { '/api/v1/me/passes': () => list(...many) } });
    expect(await screen.findByRole('link', { name: /Passes 1–10/ })).toHaveAttribute(
      'href',
      '/api/v1/me/passes.pkpasses?part=1',
    );
    expect(screen.getByRole('link', { name: /Passes 11/ })).toHaveAttribute(
      'href',
      '/api/v1/me/passes.pkpasses?part=2',
    );
  });

  it('shows the empty state', async () => {
    await renderApp('/', { handlers: { '/api/v1/me/passes': () => list() } });
    expect(await screen.findByText('No passes')).toBeInTheDocument();
    expect(screen.getByText('Passes sent to your sign-in email appear here.')).toBeInTheDocument();
  });

  it('shows an error with retry', async () => {
    let calls = 0;
    await renderApp('/', {
      handlers: {
        '/api/v1/me/passes': () =>
          ++calls === 1 ? problem(500, 'server_error', 'x') : list(passFixture()),
      },
    });
    expect(await screen.findByText('Server error. Try again.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Gym membership' })).toBeInTheDocument();
  });

  it('hides wallet actions for voided passes', async () => {
    await renderApp('/', {
      handlers: { '/api/v1/me/passes': () => list(passFixture({ status: 'voided' })) },
    });
    expect(await screen.findByText('Voided')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Add to Apple Wallet' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Refresh/ })).toBeNull();
  });

  it('loads more pages', async () => {
    const user = userEvent.setup();
    await renderApp('/', {
      handlers: {
        '/api/v1/me/passes': (url) =>
          url.searchParams.get('cursor')
            ? json({ items: [passFixture({ id: 'p2', title: 'Second' })], nextCursor: null })
            : json({ items: [passFixture()], nextCursor: 'c1' }),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('heading', { name: 'Second' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('offers a QR for the public link on desktop', async () => {
    const user = userEvent.setup();
    await renderApp('/', { handlers: { '/api/v1/me/passes': () => list(passFixture()) } });
    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Show QR' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      await within(dialog).findByRole('img', { name: 'QR code for Gym membership' }),
    ).toBeInTheDocument();
  });
});

describe('refresh', () => {
  it('goes pending, polls until refreshed, then cools down', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    const requestedAt = Date.now();
    let state: 'before' | 'pending' | 'done' = 'before';
    let posts = 0;
    await renderApp('/', {
      handlers: {
        '/api/v1/me/passes': () =>
          list(
            passFixture(
              state === 'before'
                ? {}
                : {
                    refreshRequestedAt: requestedAt,
                    lastRefreshedAt: state === 'done' ? requestedAt + 1000 : null,
                  },
            ),
          ),
        '/api/v1/me/passes/p1/refresh': () => {
          posts++;
          state = 'pending';
          return json({ accepted: true, requestedAt, cooldownSeconds: 30 }, 202);
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Refresh' }));
    const busy = await screen.findByRole('button', { name: 'Refreshing' });
    expect(busy).toBeDisabled();
    expect(posts).toBe(1);

    state = 'done';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500);
    });
    const cooling = await screen.findByRole('button', { name: /^Refresh in \d+s$/ });
    expect(cooling).toBeDisabled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(await screen.findByRole('button', { name: 'Refresh' })).toBeEnabled();
  });

  it('tells the user when the server coalesced the refresh', async () => {
    const user = userEvent.setup();
    await renderApp('/', {
      handlers: {
        '/api/v1/me/passes': () => list(passFixture()),
        '/api/v1/me/passes/p1/refresh': () =>
          json({ accepted: true, requestedAt: Date.now() - 25_000, cooldownSeconds: 30 }, 202),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Refresh already requested.')).toBeInTheDocument();
  });

  it('surfaces a rate-limit failure and stays usable', async () => {
    const user = userEvent.setup();
    await renderApp('/', {
      handlers: {
        '/api/v1/me/passes': () => list(passFixture()),
        '/api/v1/me/passes/p1/refresh': () =>
          problem(429, 'rate_limited', 'Too many refreshes. Wait a minute.'),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Too many refreshes. Wait a minute.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  });

  it('shows a pending refresh that was requested before the page loaded', async () => {
    await renderApp('/', {
      handlers: {
        '/api/v1/me/passes': () =>
          list(passFixture({ refreshRequestedAt: Date.now() - 1000, lastRefreshedAt: null })),
      },
    });
    expect(await screen.findByRole('button', { name: 'Refreshing' })).toBeDisabled();
  });
});

describe('remove', () => {
  it('confirms, deletes and refreshes the list', async () => {
    const user = userEvent.setup();
    let removed = false;
    await renderApp('/', {
      handlers: {
        '/api/v1/me/passes': () => list(...(removed ? [] : [passFixture()])),
        '/api/v1/me/passes/p1': (_u, init) => {
          if (init?.method !== 'DELETE') return problem(405, 'method_not_allowed', 'no');
          removed = true;
          return json({ ok: true });
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Remove from my passes?')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('No passes')).toBeInTheDocument();
  });

  it('cancel does nothing; failure keeps the dialog open', async () => {
    const user = userEvent.setup();
    const { fetchMock } = await renderApp('/', {
      handlers: {
        '/api/v1/me/passes': () => list(passFixture()),
        '/api/v1/me/passes/p1': () => problem(409, 'conflict', 'Pass changed. Reload.'),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }),
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(fetchMock.mock.calls.some(([, i]) => i?.method === 'DELETE')).toBe(false);

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(await within(dialog).findByText('Pass changed. Reload.')).toBeInTheDocument();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });
});
