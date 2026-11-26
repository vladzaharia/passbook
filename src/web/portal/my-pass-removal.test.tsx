import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, renderApp } from '../lib/test-utils.tsx';
import { fixtureOperation, HOLDER_REMOVE } from '../ui/operation/fixtures.test-support.ts';
import { resetOperationCache } from '../ui/operation/store.ts';
import { passFixture } from './fixtures.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  resetOperationCache();
  window.history.replaceState(null, '', '/');
});

/** The removal as the server reports it: waiting on the wallets, or done. */
const removalOp = (status: 'waiting' | 'succeeded') => {
  const op = fixtureOperation(HOLDER_REMOVE, { status, at: 'wallets', id: 'op-1' });
  if (status === 'succeeded') return op;
  return {
    ...op,
    target: { type: 'pass', id: 'p1' },
    steps: op.steps.map((s) =>
      s.key === 'wallets' ? { ...s, until: null, detail: 'Waiting for your wallets' } : s,
    ),
    text: 'Waiting for your wallets',
  };
};

describe('pass removal', () => {
  it('shows a pending removal as an operation that waits for the wallets, and ends done', async () => {
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
        return json({ transferId: 'transfer-1', state: 'pending', operationId: 'op-1' }, 202);
      },
      '/api/v1/operations/op-1': () =>
        json(removalOp(state === 'completed' ? 'succeeded' : 'waiting')),
    };
    await renderApp('/', { handlers });
    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove from My passes' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove' }),
    );
    // The sheet says what the removal waits for; the page does not claim it is done.
    const sheet = await screen.findByRole('dialog', { name: 'Remove pass' });
    expect(await within(sheet).findAllByText('Waiting for your wallets')).not.toHaveLength(0);
    expect(await screen.findByText(/Removing 1 pass\./)).toBeInTheDocument();
    expect(screen.queryByText('Removed from your passes')).toBeNull();

    // The wallets let go: the operation ends, so the list is fetched again and the notice goes.
    state = 'completed';
    await waitFor(() => expect(screen.queryByText(/Removing 1 pass\./)).toBeNull(), {
      timeout: 4000,
    });
    expect(await within(sheet).findAllByText('Pass removed')).not.toHaveLength(0);
  });

  it('a reload with the operation in the URL brings the same sheet back', async () => {
    window.history.replaceState(null, '', '/?op=op-1');
    await renderApp('/', {
      handlers: {
        '/api/v1/me/passes': () =>
          json({
            items: [],
            nextCursor: null,
            pendingRemovals: [{ passId: 'p1', transferId: 'transfer-1' }],
          }),
        '/api/v1/operations/op-1': () => json(removalOp('waiting')),
      },
    });
    const sheet = await screen.findByRole('dialog', { name: 'Remove pass' });
    expect(await within(sheet).findAllByText('Waiting for your wallets')).not.toHaveLength(0);
  });

  it('shows nothing of an operation the server will not read to this person', async () => {
    window.history.replaceState(null, '', '/?op=someone-elses');
    await renderApp('/', {
      handlers: {
        '/api/v1/me/passes': () => json({ items: [passFixture()], nextCursor: null }),
      },
    });
    await screen.findByRole('button', { name: 'More actions' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByText('Removed from your passes')).toBeNull();
  });

  it('does not infer completion merely because a pending notice disappeared', async () => {
    let visible = true;
    let receipts = 0;
    const view = await renderApp('/', {
      handlers: {
        '/api/v1/me/passes': () =>
          json({
            items: [],
            nextCursor: null,
            pendingRemovals: visible ? [{ passId: 'p1', transferId: 'transfer-1' }] : [],
          }),
        '/api/v1/me/pass-removals/transfer-1': () => {
          receipts++;
          return json({ transferId: 'transfer-1', state: 'completed' });
        },
      },
    });
    expect(await screen.findByText(/Removing 1 pass\./)).toBeVisible();
    visible = false;
    await act(() => view.queryClient.invalidateQueries({ queryKey: ['me', 'passes'] }));
    await waitFor(() => expect(screen.queryByText(/Removing 1 pass\./)).toBeNull());
    // Only the operation says a removal is done: no receipt read, no toast.
    expect(receipts).toBe(0);
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
});
