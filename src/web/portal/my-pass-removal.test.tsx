import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MyPassListSchema } from '@/shared/contracts/me.ts';
import { sessionQuery } from '../lib/session.ts';
import { json, renderApp, sessionFixture } from '../lib/test-utils.tsx';
import { pollDelay } from './api.ts';
import { passFixture } from './fixtures.ts';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => vi.unstubAllGlobals());

describe('pass removal', () => {
  it('shows a pending removal without claiming it completed, including after reload', async () => {
    const user = userEvent.setup();
    let state: 'available' | 'pending' | 'completed' = 'available';
    const handlers = {
      '/api/v1/me/passes': () =>
        json({
          items: state === 'available' ? [passFixture()] : [],
          nextCursor: null,
          pendingRemovals: state === 'pending' ? [{ passId: 'p1', transferId: 'transfer-1' }] : [],
        }),
      '/api/v1/me/passes/p1': () => {
        state = 'pending';
        return json({ transferId: 'transfer-1', state: 'pending' }, 202);
      },
      '/api/v1/me/pass-removals/transfer-1': () =>
        json({ transferId: 'transfer-1', state: state === 'completed' ? 'completed' : 'pending' }),
    };
    const first = await renderApp('/', { handlers });
    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove from My passes' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove' }),
    );
    expect(await screen.findByText(/Removing 1 pass\./)).toBeInTheDocument();
    expect(screen.queryByText('Removed from your passes')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Add to Apple Wallet' })).toBeNull();

    first.unmount();
    const reloaded = await renderApp('/', { handlers });
    expect(await screen.findByText(/Removing 1 pass\./)).toBeInTheDocument();
    state = 'completed';
    await act(() => reloaded.queryClient.invalidateQueries({ queryKey: ['me', 'passes'] }));
    await waitFor(() => expect(screen.queryByText(/Removing 1 pass\./)).toBeNull());
    expect(await screen.findByText('Removed from your passes')).toBeVisible();
  });

  it('does not infer completion merely because a pending notice disappeared', async () => {
    let visible = true;
    let checked = false;
    const view = await renderApp('/', {
      handlers: {
        '/api/v1/me/passes': () =>
          json({
            items: [],
            nextCursor: null,
            pendingRemovals: visible ? [{ passId: 'p1', transferId: 'transfer-1' }] : [],
          }),
        '/api/v1/me/pass-removals/transfer-1': () => {
          checked = true;
          return json({ transferId: 'transfer-1', state: 'pending' });
        },
      },
    });
    expect(await screen.findByText(/Removing 1 pass\./)).toBeVisible();
    visible = false;
    await act(() => view.queryClient.invalidateQueries({ queryKey: ['me', 'passes'] }));
    await waitFor(() => expect(checked).toBe(true));
    expect(screen.queryByText('Removed from your passes')).toBeNull();
  });

  it('does not notify another account when a receipt resolves after a switch', async () => {
    let visible = true;
    let started = false;
    const receipt = deferred<Response>();
    const view = await renderApp('/', {
      handlers: {
        '/api/v1/me/passes': () =>
          json({
            items: [],
            nextCursor: null,
            pendingRemovals: visible ? [{ passId: 'p1', transferId: 'transfer-1' }] : [],
          }),
        '/api/v1/me/pass-removals/transfer-1': () => {
          started = true;
          return receipt.promise;
        },
      },
    });
    await screen.findByText(/Removing 1 pass\./);
    visible = false;
    await act(() => view.queryClient.invalidateQueries({ queryKey: ['me', 'passes'] }));
    await waitFor(() => expect(started).toBe(true));
    const other = sessionFixture('user');
    if (!other.authenticated) throw new Error('Expected a signed-in user');
    act(() => {
      const updatedSession: typeof other = {
        ...other,
        user: { ...other.user, id: 'another-user' },
      };
      view.queryClient.setQueryData(sessionQuery.queryKey, updatedSession);
    });
    await act(async () => {
      receipt.resolve(json({ transferId: 'transfer-1', state: 'completed' }));
      const tick = deferred<void>();
      setTimeout(tick.resolve, 0);
      await tick.promise;
    });
    expect(screen.queryByText('Removed from your passes')).toBeNull();
  });

  it('does not claim removal succeeded for an invalid response', async () => {
    const user = userEvent.setup();
    await renderApp('/', {
      handlers: {
        '/api/v1/me/passes': () => json({ items: [passFixture()], nextCursor: null }),
        '/api/v1/me/passes/p1': () => json({ ok: true }),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove from My passes' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Could not read the response. Reload.',
    );
    expect(screen.queryByText('Removed from your passes')).toBeNull();
  });

  it('offers issuer guidance, not an attachment action, for a pass requiring reissue', async () => {
    await renderApp('/', {
      handlers: {
        '/api/v1/me/passes': () =>
          json({
            items: [],
            nextCursor: null,
            reissueRequired: [
              {
                passId: 'waiting-1',
                orgName: 'Acme',
                title: 'Gym pass',
                support: { email: 'help@acme.test', url: null },
              },
            ],
          }),
      },
    });
    const notice = await screen.findByRole('region', { name: 'Passes that need a new copy' });
    expect(within(notice).getByText(/Gym pass from Acme needs a new copy/)).toBeVisible();
    expect(within(notice).getByRole('link', { name: 'Contact Acme' })).toHaveAttribute(
      'href',
      'mailto:help@acme.test',
    );
    expect(within(notice).queryByRole('button')).toBeNull();
    expect(screen.queryByText('Removed from your passes')).toBeNull();
  });

  it('keeps polling while a removal is pending, backing off to a minute', () => {
    const page = MyPassListSchema.parse({
      items: [],
      nextCursor: null,
      pendingRemovals: [{ passId: 'p1', transferId: 'transfer-1' }],
    });
    const data = { pages: [page], pageParams: [undefined] };
    expect(pollDelay(data, 1)).toBe(3000);
    expect(pollDelay(data, 4)).toBeGreaterThan(pollDelay(data, 2) as number);
    expect(pollDelay(data, 100)).toBe(60_000);
    expect(
      pollDelay({ pages: [{ ...page, pendingRemovals: [] }], pageParams: [undefined] }, 1),
    ).toBe(false);
  });
});
