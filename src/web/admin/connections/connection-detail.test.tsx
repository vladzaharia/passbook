import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { membershipsQuery } from '../../lib/session.ts';
import {
  type FetchHandler,
  json,
  membershipFixture,
  problem,
  renderApp,
} from '../../lib/test-utils.tsx';
import {
  CONNECTOR,
  connectionDetail,
  ORG,
  templateDetail,
  templateSummary,
} from '../passes/test-fixtures.ts';
import { connectionKeys } from './api.ts';

const method = (init?: RequestInit) => (init?.method ?? 'GET').toUpperCase();
const membership = membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug });
const reader = membershipFixture(ORG.id, {
  orgName: ORG.name,
  orgSlug: ORG.slug,
  capabilities: ['integrations:read', 'templates:read'],
});

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
  it('shows connection health without mutation actions to a read-only member', async () => {
    await renderApp('/admin/connections/c1', {
      session: 'admin',
      memberships: [reader],
      selectedOrg: ORG.id,
      handlers: handlers({ c: connectionDetail() }),
    });

    expect(await screen.findByRole('heading', { name: 'MemberSpot sync' })).toBeVisible();
    expect(screen.getByRole('table', { name: 'Connection runs' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Test' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry now' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More' })).not.toBeInTheDocument();
  });

  it('closes an open action if the selected membership loses management capability', async () => {
    const user = userEvent.setup();
    const { queryClient } = await renderApp('/admin/connections/c1', {
      session: 'admin',
      memberships: [membership],
      selectedOrg: ORG.id,
      handlers: handlers({ c: connectionDetail() }),
    });
    await user.click(await screen.findByRole('button', { name: 'More' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    expect(await screen.findByRole('dialog', { name: 'Delete MemberSpot sync?' })).toBeVisible();

    act(() => {
      queryClient.setQueryData(membershipsQuery.queryKey, { items: [reader] });
    });
    await waitFor(() =>
      expect(screen.queryByText('Delete MemberSpot sync?')).not.toBeInTheDocument(),
    );
    expect(await screen.findByRole('heading', { name: 'MemberSpot sync' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Test' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More' })).not.toBeInTheDocument();

    act(() => {
      queryClient.setQueryData(membershipsQuery.queryKey, { items: [membership] });
    });
    expect(await screen.findByRole('button', { name: 'Test' })).toBeVisible();
    expect(screen.queryByText('Delete MemberSpot sync?')).not.toBeInTheDocument();
  });

  it('has no disclaimer card and opens the configuration tab', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/connections/c1', {
      session: 'admin',
      memberships: [membership],
      selectedOrg: ORG.id,
      handlers: handlers({ c: connectionDetail() }),
    });
    expect(await screen.findByRole('tab', { name: 'Configuration' })).toBeVisible();
    expect(screen.queryByText(/do not establish sync success/)).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'Configuration' }));
    expect(screen.getByRole('tab', { name: 'Configuration' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(await screen.findByRole('heading', { name: 'Connector' })).toBeVisible();
  });

  it('opens Health with the sentence, the run strip and the runs, accessibly', async () => {
    const state = { c: connectionDetail() };
    const { container } = await renderApp('/admin/connections/c1', {
      session: 'admin',
      memberships: [membership],
      selectedOrg: ORG.id,
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
    const passesLink = screen.getByRole('link', { name: /2 passes/ });
    const passesUrl = new URL(passesLink.getAttribute('href') ?? '', 'http://localhost');
    expect(passesUrl.pathname).toBe('/admin/passes');
    expect(Object.fromEntries(passesUrl.searchParams)).toEqual({
      connectionId: 'c1',
      orgId: ORG.id,
    });
    expect((await axe(container)).violations).toEqual([]);
  });

  it('expands sampled record errors on a failed run', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/connections/c1', {
      session: 'admin',
      memberships: [membership],
      selectedOrg: ORG.id,
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
      memberships: [membership],
      selectedOrg: ORG.id,
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
      memberships: [membership],
      selectedOrg: ORG.id,
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
      memberships: [membership],
      selectedOrg: ORG.id,
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
      memberships: [membership],
      selectedOrg: ORG.id,
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
      memberships: [membership],
      selectedOrg: ORG.id,
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
      memberships: [membership],
      selectedOrg: ORG.id,
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
      memberships: [membership],
      selectedOrg: ORG.id,
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

  it('opens an unscoped deep link in the connection organization rather than a remembered one', async () => {
    localStorage.setItem('wallet-org-filter', 'org2');
    try {
      const { router } = await renderApp('/admin/connections/c1', {
        session: 'admin',
        memberships: [
          membership,
          membershipFixture('org2', {
            orgName: 'Second',
            orgSlug: 'second',
            capabilities: ['scanning:read'],
          }),
        ],
        handlers: handlers({ c: connectionDetail() }),
      });

      expect(await screen.findByRole('heading', { name: 'MemberSpot sync' })).toBeVisible();
      await waitFor(() => expect(router.state.location.search).toMatchObject({ orgId: ORG.id }));
      expect(screen.getByRole('combobox', { name: /^Organization filter/ })).toHaveTextContent(
        ORG.name,
      );
      expect(screen.getByRole('button', { name: 'Test' })).toBeVisible();
    } finally {
      localStorage.removeItem('wallet-org-filter');
    }
  });

  it('waits for verified ownership before loading an organization-scoped connector catalog', async () => {
    const deferred = Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
    };
    const reply = deferred.withResolvers<Response>();
    const catalogRequests: { path: string; orgId: string | null }[] = [];
    await renderApp('/admin/connections/c1', {
      session: 'admin',
      memberships: [membership],
      selectedOrg: ORG.id,
      handlers: handlers(
        { c: connectionDetail() },
        {
          '/api/v1/connections/c1': () => reply.promise,
          '/api/v1/connectors': (url) => {
            catalogRequests.push({ path: url.pathname, orgId: url.searchParams.get('orgId') });
            return json({ items: [CONNECTOR] });
          },
          '/api/v1/connectors/http-json': (url) => {
            catalogRequests.push({ path: url.pathname, orgId: url.searchParams.get('orgId') });
            return json(CONNECTOR);
          },
        },
      ),
    });

    expect(await screen.findByText('Loading connection')).toBeInTheDocument();
    expect(catalogRequests).toEqual([]);
    await act(async () => {
      reply.resolve(json(connectionDetail()));
      await reply.promise;
    });
    expect(await screen.findByRole('heading', { name: 'MemberSpot sync' })).toBeVisible();
    await waitFor(() => expect(catalogRequests).toHaveLength(2));
    expect(catalogRequests).toEqual(
      expect.arrayContaining([
        { path: '/api/v1/connectors', orgId: ORG.id },
        { path: '/api/v1/connectors/http-json', orgId: ORG.id },
      ]),
    );
  });

  it('revalidates cached ownership on an explicitly scoped connection link', async () => {
    const deferred = Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
    };
    const reply = deferred.withResolvers<Response>();
    let requested = false;
    let dependentRequests = 0;
    const { router, queryClient } = await renderApp('/admin', {
      session: 'admin',
      memberships: [
        membership,
        membershipFixture('org2', { orgName: 'Second', orgSlug: 'second' }),
      ],
      handlers: handlers(
        { c: connectionDetail() },
        {
          '/api/v1/connections/c1': () => {
            requested = true;
            return reply.promise;
          },
          '/api/v1/connectors/http-json': () => {
            dependentRequests += 1;
            return json(CONNECTOR);
          },
        },
      ),
    });
    await screen.findByRole('combobox', { name: /^Organization filter/ });
    act(() => {
      queryClient.setQueryData(
        connectionKeys.detail('c1'),
        connectionDetail({ name: 'Cached private connection' }),
      );
    });
    await act(async () => {
      await router.navigate({
        to: '/admin/connections/$connectionId',
        params: { connectionId: 'c1' },
        search: { orgId: ORG.id },
      });
    });
    await waitFor(() => expect(requested).toBe(true));
    expect(screen.getByText('Loading connection')).toBeInTheDocument();
    expect(screen.queryByText('Cached private connection')).not.toBeInTheDocument();
    expect(dependentRequests).toBe(0);

    reply.resolve(json(connectionDetail({ orgId: 'org2', name: 'Moved connection' })));
    expect(await screen.findByText('Connection not found')).toBeVisible();
    expect(screen.queryByText('Cached private connection')).not.toBeInTheDocument();
    expect(screen.queryByText('Moved connection')).not.toBeInTheDocument();
    expect(dependentRequests).toBe(0);
  });

  it.each(['denied', 'changed'])(
    'revalidates cached connection data on an unscoped link when access is %s',
    async (outcome) => {
      localStorage.setItem('wallet-org-filter', 'org2');
      try {
        const deferred = Promise as PromiseConstructor & {
          withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
        };
        const reply = deferred.withResolvers<Response>();
        let requested = false;
        let dependentRequests = 0;
        const { router, queryClient } = await renderApp('/admin', {
          session: 'admin',
          memberships: [
            membership,
            membershipFixture('org2', { orgName: 'Second', orgSlug: 'second' }),
          ],
          handlers: handlers(
            { c: connectionDetail() },
            {
              '/api/v1/connections/c1': () => {
                requested = true;
                return reply.promise.then((response) => response.clone());
              },
              '/api/v1/connectors/http-json': () => {
                dependentRequests += 1;
                return json(CONNECTOR);
              },
            },
          ),
        });
        await screen.findByRole('combobox', { name: /^Organization filter/ });
        act(() => {
          queryClient.setQueryData(
            connectionKeys.detail('c1'),
            connectionDetail({ name: 'Cached private connection' }),
          );
        });
        await act(async () => {
          await router.navigate({
            to: '/admin/connections/$connectionId',
            params: { connectionId: 'c1' },
            search: {},
          });
        });
        await waitFor(() => expect(requested).toBe(true));
        expect(screen.getByText('Loading connection')).toBeInTheDocument();
        expect(router.state.location.search).not.toHaveProperty('orgId');
        expect(screen.queryByText('Cached private connection')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Test' })).not.toBeInTheDocument();
        expect(dependentRequests).toBe(0);

        reply.resolve(
          outcome === 'denied'
            ? problem(403, 'forbidden', 'Access denied.')
            : json(connectionDetail({ orgId: 'org2', name: 'Fresh connection' })),
        );
        if (outcome === 'denied') {
          expect(
            await screen.findByRole('heading', { name: 'You do not have access' }),
          ).toBeVisible();
          expect(router.state.location.search).not.toHaveProperty('orgId');
          expect(dependentRequests).toBe(0);
        } else {
          expect(await screen.findByRole('heading', { name: 'Fresh connection' })).toBeVisible();
          await waitFor(() =>
            expect(router.state.location.search).toMatchObject({ orgId: 'org2' }),
          );
        }
        expect(screen.queryByText('Cached private connection')).not.toBeInTheDocument();
      } finally {
        localStorage.removeItem('wallet-org-filter');
      }
    },
  );

  it('revalidates when an existing detail route loses its explicit organization', async () => {
    const deferred = Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
    };
    const reply = deferred.withResolvers<Response>();
    let revalidating = false;
    let requested = false;
    const { router } = await renderApp('/admin/connections/c1', {
      session: 'admin',
      memberships: [membership],
      selectedOrg: ORG.id,
      handlers: handlers(
        { c: connectionDetail() },
        {
          '/api/v1/connections/c1': () => {
            if (!revalidating) return json(connectionDetail());
            requested = true;
            return reply.promise;
          },
        },
      ),
    });
    expect(await screen.findByRole('heading', { name: 'MemberSpot sync' })).toBeVisible();

    revalidating = true;
    await act(async () => {
      await router.navigate({
        to: '/admin/connections/$connectionId',
        params: { connectionId: 'c1' },
        search: { orgId: undefined },
      });
    });
    await waitFor(() => expect(requested).toBe(true));
    expect(router.state.location.search.orgId).toBeUndefined();
    expect(screen.getByText('Loading connection')).toBeInTheDocument();
    expect(screen.queryByText('MemberSpot sync')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Test' })).not.toBeInTheDocument();

    reply.resolve(problem(403, 'forbidden', 'Access denied.'));
    expect(await screen.findByRole('heading', { name: 'You do not have access' })).toBeVisible();
    expect(router.state.location.search.orgId).toBeUndefined();
    expect(screen.queryByText('MemberSpot sync')).not.toBeInTheDocument();
  });

  it('masks a connection when an explicit organization conflicts with its actual organization', async () => {
    const foreign = connectionDetail({ orgId: 'org2', name: 'Private connection' });
    await renderApp(`/admin/connections/c1?orgId=${ORG.id}`, {
      session: 'admin',
      memberships: [
        membership,
        membershipFixture('org2', { orgName: 'Second', orgSlug: 'second' }),
      ],
      handlers: handlers({ c: foreign }),
    });

    expect(await screen.findByText('Connection not found')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Connection' })).toBeInTheDocument();
    expect(screen.queryByText('Private connection')).not.toBeInTheDocument();
    expect(screen.queryByText(/UPSTREAM_5XX/)).not.toBeInTheDocument();
    expect(screen.queryByRole('tablist', { name: 'Connection sections' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Test' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More' })).not.toBeInTheDocument();
  });

  it('clears connection details and session test results when the organization changes', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/connections/c1', {
      session: 'admin',
      memberships: [
        membership,
        membershipFixture('org2', { orgName: 'Second', orgSlug: 'second' }),
      ],
      selectedOrg: ORG.id,
      handlers: handlers(
        { c: connectionDetail() },
        {
          '/api/v1/connections/c1/test': () =>
            json({ ok: true, durationMs: 120, detail: 'Private test result.' }),
        },
      ),
    });

    expect(await screen.findByRole('heading', { name: 'MemberSpot sync' })).toBeVisible();
    await waitFor(() => expect(document.title).toContain('MemberSpot sync'));
    expect(screen.getByText('Organization').nextElementSibling).toHaveTextContent(ORG.name);
    await user.click(screen.getByRole('button', { name: 'Test' }));
    expect(await screen.findByText('Private test result. 120 ms.')).toBeVisible();

    await user.click(screen.getByRole('combobox', { name: /^Organization filter/ }));
    await user.click(await screen.findByRole('option', { name: 'Second' }));
    expect(await screen.findByText('Connection not found')).toBeVisible();
    expect(screen.queryByText('MemberSpot sync')).not.toBeInTheDocument();
    await waitFor(() => expect(document.title).not.toContain('MemberSpot sync'));
    expect(screen.queryByText('Private test result. 120 ms.')).not.toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Connection runs' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Test' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: /^Organization filter/ }));
    await user.click(await screen.findByRole('option', { name: ORG.name }));
    expect(await screen.findByRole('heading', { name: 'MemberSpot sync' })).toBeVisible();
    expect(screen.queryByText('Private test result. 120 ms.')).not.toBeInTheDocument();
  });

  it('closes an open delete dialog when the selected organization changes', async () => {
    const user = userEvent.setup();
    const { router } = await renderApp('/admin/connections/c1', {
      session: 'admin',
      memberships: [
        membership,
        membershipFixture('org2', { orgName: 'Second', orgSlug: 'second' }),
      ],
      selectedOrg: ORG.id,
      handlers: handlers({ c: connectionDetail() }),
    });

    await user.click(await screen.findByRole('button', { name: 'More' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    expect(await screen.findByRole('dialog', { name: 'Delete MemberSpot sync?' })).toBeVisible();

    await act(async () => {
      await router.navigate({
        to: '/admin/connections/$connectionId',
        params: { connectionId: 'c1' },
        search: { orgId: 'org2' },
      });
    });
    expect(await screen.findByText('Connection not found')).toBeVisible();
    expect(screen.queryByText('Delete MemberSpot sync?')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Test' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument();
  });

  it('discards a connection response that arrives after switching organizations', async () => {
    const user = userEvent.setup();
    const deferred = Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
    };
    const reply = deferred.withResolvers<Response>();
    let requested = false;
    const { router } = await renderApp('/admin/connections/c1', {
      session: 'admin',
      memberships: [
        membership,
        membershipFixture('org2', { orgName: 'Second', orgSlug: 'second' }),
      ],
      selectedOrg: ORG.id,
      handlers: handlers(
        { c: connectionDetail() },
        {
          '/api/v1/connections/c1': () => {
            requested = true;
            return reply.promise.then((response) => response.clone());
          },
        },
      ),
    });

    expect(await screen.findByText('Loading connection')).toBeInTheDocument();
    await waitFor(() => expect(requested).toBe(true));
    await user.click(screen.getByRole('combobox', { name: /^Organization filter/ }));
    await user.click(await screen.findByRole('option', { name: 'Second' }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ orgId: 'org2' }));
    reply.resolve(json(connectionDetail()));

    expect(await screen.findByText('Connection not found')).toBeVisible();
    expect(screen.queryByText('MemberSpot sync')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Test' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument();
  });

  it('shows not found with the header and a way back, and no retry', async () => {
    await renderApp('/admin/connections/c1', {
      session: 'admin',
      memberships: [membership],
      selectedOrg: ORG.id,
      handlers: {
        '/api/v1/orgs': () => json({ items: [ORG], nextCursor: null }),
        '/api/v1/connections/c1': () => problem(404, 'not_found', 'Connection not found.'),
      },
    });
    expect(await screen.findByText('Connection not found')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Connection' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to connections' })).toHaveAttribute(
      'href',
      '/admin/connections?orgId=org1',
    );
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});
