import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { type FetchHandler, json, problem, renderApp } from '../../lib/test-utils.tsx';
import {
  CONNECTOR,
  connectionDetail,
  ORG,
  templateDetail,
  templateSummary,
} from '../passes/test-fixtures.ts';

const method = (init?: RequestInit) => (init?.method ?? 'GET').toUpperCase();

type State = { c: ReturnType<typeof connectionDetail> };
function handlers(state: State, extra: Record<string, FetchHandler> = {}, patches: unknown[] = []) {
  return {
    '/api/v1/orgs': () => json({ items: [ORG], nextCursor: null }),
    '/api/v1/templates': () => json({ items: [templateSummary()], nextCursor: null }),
    '/api/v1/templates/tpl1': () => json(templateDetail()),
    '/api/v1/connectors/http-json': () => json(CONNECTOR),
    '/api/v1/connections/c1': (_u: URL, init?: RequestInit) => {
      if (method(init) === 'PATCH') {
        const body = JSON.parse(String(init?.body));
        patches.push(body);
        state.c = { ...state.c, ...body };
      }
      return json(state.c);
    },
    ...extra,
  } satisfies Record<string, FetchHandler>;
}

describe('connection detail', () => {
  it('opens Health with the sentence, the run strip and the runs, accessibly', async () => {
    const state = { c: connectionDetail() };
    const { container } = await renderApp('/admin/connections/c1', {
      session: 'admin',
      handlers: handlers(state),
    });
    // The sentence opens with the pill's word.
    expect(await screen.findByText(/^Degraded since .* · 2 failures in a row/)).toBeInTheDocument();
    expect(screen.getByText('Paused after repeated failures')).toBeInTheDocument();
    expect(screen.queryByText('Breaker')).toBeNull();
    expect(screen.getByRole('list', { name: 'Recent runs' }).children).toHaveLength(2);
    expect(screen.getByText('400 ms / 900 ms')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Connection runs' });
    expect(within(table).getByText('UPSTREAM_5XX · 503')).toBeInTheDocument();
    expect(within(table).getByText('10 seen, 2 changed')).toBeInTheDocument();
    // One health pill: the header's.
    expect(screen.getAllByText('Degraded')).toHaveLength(1);
    expect(screen.getByRole('link', { name: /2 passes/ })).toHaveAttribute(
      'href',
      '/admin/passes?connectionId=c1',
    );
    expect((await axe(container)).violations).toEqual([]);
  });

  it('expands sampled record errors on a failed run', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/connections/c1', {
      session: 'admin',
      handlers: handlers({ c: connectionDetail() }),
    });
    const table = await screen.findByRole('table', { name: 'Connection runs' });
    await user.click(within(table).getByText('2 sampled errors'));
    expect(within(table).getByText(/m-2: INVALID level not allowed/)).toBeVisible();
  });

  it('shows the test result in a reserved slot: pass, then a failure with its code', async () => {
    const user = userEvent.setup();
    let ok = true;
    const { container } = await renderApp('/admin/connections/c1', {
      session: 'admin',
      handlers: handlers(
        { c: connectionDetail() },
        {
          '/api/v1/connections/c1/test': () =>
            ok
              ? json({ ok: true, durationMs: 120, detail: 'Record fetched.' })
              : json({ ok: false, errorCode: 'AUTH', durationMs: 90 }),
        },
      ),
    });
    const tabs = await screen.findByRole('tablist');
    const slot = container.querySelector('header [role="status"]');
    expect(slot).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Test' }));
    expect(await screen.findByText('Test passed')).toBeInTheDocument();
    expect(screen.getByText('Record fetched. 120 ms.')).toBeInTheDocument();
    ok = false;
    await user.click(screen.getByRole('button', { name: 'Test' }));
    expect(await screen.findByText('Test failed')).toBeInTheDocument();
    expect(screen.getByText('The source rejected the credentials. Replace them.')).toBeVisible();
    expect(within(slot as HTMLElement).getByText('AUTH')).toHaveClass('font-mono');
    expect(container.querySelector('.wl-result')?.getAttribute('data-result')).toBe('fail');
    expect(screen.getByRole('tablist')).toBe(tabs);
  });

  it('starts a sync and toggles enabled; push-only connectors have no Sync now', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    await renderApp('/admin/connections/c1', {
      session: 'admin',
      handlers: handlers(
        { c: connectionDetail() },
        {
          '/api/v1/connections/c1/sync': () => {
            calls.push('sync');
            return json({ runId: 'r9', workflowInstanceId: 'w9' }, 202);
          },
        },
      ),
    });
    await user.click(await screen.findByRole('button', { name: 'Sync now' }));
    await waitFor(() => expect(calls).toEqual(['sync']));
    await user.click(screen.getByRole('button', { name: 'More' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Disable' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sync now' })).toBeDisabled());
  });

  it('hides Sync now for a push-only connector', async () => {
    await renderApp('/admin/connections/c1', {
      session: 'admin',
      handlers: handlers(
        { c: connectionDetail({ connectorType: 'webhook-push', mode: 'webhook' }) },
        {
          '/api/v1/connectors/webhook-push': () =>
            json({
              ...CONNECTOR,
              type: 'webhook-push',
              capabilities: {
                poll: false,
                delta: false,
                webhook: true,
                import: false,
                snapshot: false,
              },
            }),
        },
      ),
    });
    expect(await screen.findByRole('button', { name: 'Test' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull());
  });

  it('saves lifecycle settings in minutes and checks auto create needs a template', async () => {
    const user = userEvent.setup();
    const patches: Record<string, unknown>[] = [];
    await renderApp('/admin/connections/c1?tab=settings', {
      session: 'admin',
      handlers: handlers({ c: connectionDetail({ defaultTemplateId: null }) }, {}, patches),
    });
    const interval = await screen.findByLabelText('Interval');
    expect(interval).toHaveValue(60);
    await user.clear(interval);
    await user.type(interval, '10');
    await user.click(screen.getByRole('switch', { name: 'Create passes for new records' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Choose a template on Mapping to create passes.')).toBeVisible();
    expect(patches).toHaveLength(0);
    await user.click(screen.getByRole('switch', { name: 'Create passes for new records' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toMatchObject({ intervalSeconds: 600, autoCreate: false, mode: 'poll' });
    expect(screen.queryByRole('combobox', { name: /template/i })).toBeNull();
  });

  it('hides the webhook tab and unsupported modes for poll-only connectors', async () => {
    await renderApp('/admin/connections/c1?tab=settings', {
      session: 'admin',
      handlers: handlers(
        { c: connectionDetail() },
        {
          '/api/v1/connectors/http-json': () =>
            json({
              ...CONNECTOR,
              capabilities: {
                poll: true,
                delta: true,
                webhook: false,
                import: false,
                snapshot: false,
              },
            }),
        },
      ),
    });
    await screen.findByRole('radio', { name: /Poll/ });
    await waitFor(() =>
      expect(screen.getAllByRole('radio').map((r) => (r as HTMLInputElement).value)).toEqual([
        'poll',
        'manual',
      ]),
    );
    expect(screen.queryByRole('tab', { name: 'Webhook' })).not.toBeInTheDocument();
  });

  it('rotates the secret next to it and shows the new one once', async () => {
    const user = userEvent.setup();
    const patches: Record<string, unknown>[] = [];
    await renderApp('/admin/connections/c1?tab=webhook', {
      session: 'admin',
      handlers: handlers({ c: connectionDetail({ mode: 'webhook' }) }, {}, patches),
    });
    expect(await screen.findByText('https://wallet.example/hooks/connections/c1')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Create' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(patches[0]?.webhookSecret).toMatch(/^[0-9a-f]{64}$/));
    expect(await screen.findByRole('button', { name: 'Copy signing secret' })).toBeVisible();
    expect(screen.getByText(/not shown again/i)).toBeInTheDocument();
  });

  it('needs the name typed before deleting', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    const state = { c: connectionDetail() };
    const { router } = await renderApp('/admin/connections/c1', {
      session: 'admin',
      handlers: handlers(state, {
        '/api/v1/connections/c1': (_u, init) => {
          if (method(init) === 'DELETE') calls.push('DELETE');
          return json(method(init) === 'DELETE' ? { ok: true } : state.c);
        },
        '/api/v1/connections': () => json({ items: [], nextCursor: null }),
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'More' }));
    const entries = router.history.length;
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete MemberSpot sync?' });
    expect(dialog).toHaveTextContent('Bound passes keep their data and stop syncing.');
    expect(dialog).toHaveTextContent('This cannot be undone.');
    const confirm = within(dialog).getByRole('button', { name: 'Delete' });
    expect(confirm).toBeDisabled();
    await user.type(
      within(dialog).getByLabelText('Type MemberSpot sync to confirm'),
      'memberspot sync',
    );
    await user.click(confirm);
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/connections'));
    expect(calls).toEqual(['DELETE']);
    // Back does not land on the deleted connection.
    expect(router.history.length).toBe(entries);
  });

  it('shows not found with the header and a way back, and no retry', async () => {
    await renderApp('/admin/connections/c1', {
      session: 'admin',
      handlers: {
        '/api/v1/orgs': () => json({ items: [ORG], nextCursor: null }),
        '/api/v1/connections/c1': () => problem(404, 'not_found', 'Connection not found.'),
      },
    });
    expect(await screen.findByText('Connection not found')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Connection' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to connections' })).toHaveAttribute(
      'href',
      '/admin/connections',
    );
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});
