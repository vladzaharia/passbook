import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetModeForTests, setMode } from '@/web/lib/mode.ts';
import { json, problem, renderApp } from '@/web/lib/test-utils.tsx';
import { ORG, templateDetail } from '../passes/test-fixtures.ts';
import { broadcast } from './test-fixtures.ts';

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
afterEach(() => {
  resetModeForTests();
  vi.unstubAllGlobals();
});

const base = {
  '/api/v1/orgs': () => json({ items: [ORG], nextCursor: null }),
  '/api/v1/templates/t1': () => json(templateDetail({ id: 't1', name: 'Copper card' })),
  '/api/v1/broadcasts/preview': () => json({ targeted: 3, onDevice: 2, overBudget: 1, limit: 3 }),
};
const item = (over: Record<string, unknown> = {}) => ({
  passId: 'pass-0001',
  holder: 'sam@example.com',
  outcome: 'failed',
  silent: false,
  ...over,
});

describe('Message detail', () => {
  it('sends a draft after the audience count, noting passes at the daily limit', async () => {
    const sent: unknown[] = [];
    await renderApp('/admin/messages/b1', {
      session: 'admin',
      handlers: {
        ...base,
        '/api/v1/broadcasts/b1': () => json(broadcast({ state: 'draft', startedAt: null })),
        '/api/v1/broadcasts/b1/send': (_u, init) => {
          sent.push(JSON.parse(String(init?.body)));
          return json(broadcast({ state: 'sending' }));
        },
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Send' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Send to 3 passes?' });
    expect(within(dialog).getByText('Holders are notified at once.')).toBeInTheDocument();
    expect(
      within(dialog).getByText('1 pass is at the daily limit and updates quietly.'),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(sent).toEqual([{}]));
  });

  it('shows a failed send inside the confirm', async () => {
    await renderApp('/admin/messages/b1', {
      session: 'admin',
      handlers: {
        ...base,
        '/api/v1/broadcasts/b1': () => json(broadcast({ state: 'draft', startedAt: null })),
        '/api/v1/broadcasts/b1/send': () => problem(409, 'CONFLICT', 'Already sent.'),
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Send' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(await within(dialog).findByRole('button', { name: 'Send' }));
    expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
  });

  it('opens a draft in the composer and deletes it with its own words', async () => {
    const cancelled: string[] = [];
    const { router } = await renderApp('/admin/messages/b1', {
      session: 'admin',
      handlers: {
        ...base,
        '/api/v1/broadcasts': () => json({ items: [], nextCursor: null }),
        '/api/v1/broadcasts/b1': () => json(broadcast({ state: 'draft', startedAt: null })),
        '/api/v1/broadcasts/b1/cancel': (u) => {
          cancelled.push(u.pathname);
          return json(broadcast({ state: 'cancelled' }));
        },
      },
    });
    const user = userEvent.setup();
    expect(await screen.findByRole('link', { name: 'Edit' })).toHaveAttribute(
      'href',
      '/admin/messages/new?from=b1',
    );
    await user.click(screen.getByRole('button', { name: 'Delete draft' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete Doors open late?' });
    expect(within(dialog).getByRole('button', { name: 'Keep it' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete draft' }));
    await waitFor(() => expect(cancelled).toEqual(['/api/v1/broadcasts/b1/cancel']));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/messages'));
  });

  it('calls a scheduled change off with "change" wording', async () => {
    await renderApp('/admin/messages/b1', {
      session: 'admin',
      handlers: {
        ...base,
        '/api/v1/broadcasts/b1': () =>
          json(
            broadcast({
              kind: 'change',
              state: 'scheduled',
              at: Date.now() + 3_600_000,
              startedAt: null,
              patch: { level: 'blue' },
            }),
          ),
      },
    });
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Cancel change' }));
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
  });

  it('retries a failed message on the server and opens the new one', async () => {
    const retried: string[] = [];
    const { router } = await renderApp('/admin/messages/b1', {
      session: 'admin',
      handlers: {
        ...base,
        '/api/v1/broadcasts/b1': () =>
          json(broadcast({ state: 'failed', errorCode: 'BROADCAST_FAILED' })),
        '/api/v1/broadcasts/b1/items': () => json({ items: [item()], nextCursor: null }),
        '/api/v1/broadcasts/b1/retry': (u) => {
          retried.push(u.pathname);
          return json(broadcast({ id: 'b2', state: 'sending' }));
        },
        '/api/v1/broadcasts/b2': () => json(broadcast({ id: 'b2', state: 'sending' })),
        '/api/v1/broadcasts/b2/items': () => json({ items: [], nextCursor: null }),
      },
    });
    expect(
      await screen.findByText(
        'It stopped before every pass was handled. Send again to finish the rest.',
      ),
    ).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Send again' }));
    await waitFor(() => expect(retried).toEqual(['/api/v1/broadcasts/b1/retry']));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/messages/b2'));
  });

  it('does not offer Send again in another mode', async () => {
    await renderApp('/admin/messages/b1', {
      session: 'admin',
      handlers: {
        ...base,
        '/api/v1/broadcasts/b1': () =>
          json(broadcast({ mode: 'test', state: 'failed', errorCode: 'BROADCAST_FAILED' })),
        '/api/v1/broadcasts/b1/items': () => json({ items: [], nextCursor: null }),
      },
    });
    expect(await screen.findByText(/Switch to Test mode to send again\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send again' })).not.toBeInTheDocument();
  });

  it('lists the passes by outcome with a link to each Sync log', async () => {
    setMode('live');
    const asked: (string | null)[] = [];
    await renderApp('/admin/messages/b1', {
      session: 'admin',
      handlers: {
        ...base,
        '/api/v1/broadcasts/b1': () =>
          json(
            broadcast({
              state: 'partial',
              counts: { targeted: 3, updated: 2, unchanged: 0, overBudget: 0, failed: 1 },
            }),
          ),
        '/api/v1/broadcasts/b1/items': (u) => {
          asked.push(u.searchParams.get('outcome'));
          return json({ items: [item()], nextCursor: null });
        },
      },
    });
    expect(await screen.findByText('1 pass could not be updated.')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Show failed' }));
    await waitFor(() => expect(asked).toContain('failed'));
    const link = await screen.findByRole('link', { name: /Sync log of sam@example.com/ });
    expect(link).toHaveAttribute('href', '/admin/passes/pass-0001?tab=sync');
    expect(screen.getByText('Silent (daily limit)')).toBeInTheDocument();
  });

  it('names a change by the template label, not its key', async () => {
    await renderApp('/admin/messages/b1', {
      session: 'admin',
      handlers: {
        ...base,
        '/api/v1/broadcasts/b1': () =>
          json(broadcast({ kind: 'change', patch: { level: 'blue' } })),
        '/api/v1/broadcasts/b1/items': () => json({ items: [], nextCursor: null }),
      },
    });
    expect(await screen.findByText('Level')).toBeInTheDocument();
    expect(screen.getByText('Blue')).toBeInTheDocument();
    expect(screen.queryByText('level')).not.toBeInTheDocument();
  });

  it('keeps the page when a poll fails', async () => {
    let calls = 0;
    const { queryClient } = await renderApp('/admin/messages/b1', {
      session: 'admin',
      handlers: {
        ...base,
        '/api/v1/broadcasts/b1': () => {
          calls += 1;
          return calls === 1
            ? json(broadcast({ state: 'sending' }))
            : problem(500, 'server_error', 'Down.');
        },
        '/api/v1/broadcasts/b1/items': () => json({ items: [], nextCursor: null }),
      },
    });
    expect(await screen.findByRole('heading', { name: 'Doors open late' })).toBeInTheDocument();
    await queryClient.refetchQueries({ queryKey: ['admin', 'broadcasts', 'detail', 'b1'] });
    expect(screen.getByRole('heading', { name: 'Doors open late' })).toBeInTheDocument();
  });
});
