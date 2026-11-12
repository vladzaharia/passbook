import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetModeForTests, setMode } from '@/web/lib/mode.ts';
import { json, membershipFixture, problem, renderApp } from '@/web/lib/test-utils.tsx';
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

const messageOrg = { ...ORG, id: 'o1' };
const orgAccess = {
  memberships: [
    membershipFixture(messageOrg.id, { orgName: messageOrg.name, orgSlug: messageOrg.slug }),
  ],
  selectedOrg: messageOrg.id,
};
const otherMembership = membershipFixture('o2', {
  orgName: 'Harbor',
  orgSlug: 'harbor',
});

const base = {
  '/api/v1/orgs': () => json({ items: [messageOrg], nextCursor: null }),
  '/api/v1/templates/t1': () =>
    json(templateDetail({ id: 't1', orgId: messageOrg.id, name: 'Copper card' })),
  '/api/v1/broadcasts/preview': () => json({ targeted: 3, onDevice: 2, overBudget: 1, limit: 3 }),
};
const item = (over: Record<string, unknown> = {}) => ({
  passId: 'pass-0001',
  title: 'Copper card',
  holderEmail: 'sam@example.com',
  outcome: 'failed',
  silent: false,
  ...over,
});

describe('Message detail', () => {
  it('resolves a bare message link to its authorized organization instead of the remembered one', async () => {
    localStorage.setItem('wallet-org-filter', messageOrg.id);
    let requests = 0;
    const { router } = await renderApp('/admin/messages/b1', {
      session: 'user',
      memberships: [...orgAccess.memberships, otherMembership],
      handlers: {
        ...base,
        '/api/v1/broadcasts/b1': () => {
          requests += 1;
          return json(
            broadcast({
              orgId: otherMembership.orgId,
              name: 'Harbor message',
              state: 'draft',
              startedAt: null,
            }),
          );
        },
        '/api/v1/templates/t1': () =>
          json(templateDetail({ id: 't1', orgId: otherMembership.orgId, name: 'Harbor card' })),
      },
    });
    expect(await screen.findByRole('heading', { name: 'Harbor message' })).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.search.orgId).toBe(otherMembership.orgId));
    expect(localStorage.getItem('wallet-org-filter')).toBe(otherMembership.orgId);
    expect(requests).toBeGreaterThan(0);
    expect(
      screen.getByText('Organization', { selector: 'dt' }).nextElementSibling,
    ).toHaveTextContent('Harbor');
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  it.each(['moved', 'denied'] as const)(
    'revalidates a cached message before resolving a bare link when access has %s',
    async (outcome) => {
      const deferred = Promise as PromiseConstructor & {
        withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
      };
      const response = deferred.withResolvers<Response>();
      let requests = 0;
      const templateScopes: (string | null)[] = [];
      const { router } = await renderApp('/admin/messages/b1', {
        session: 'admin',
        memberships: [...orgAccess.memberships, otherMembership],
        selectedOrg: messageOrg.id,
        handlers: {
          '/api/v1/broadcasts/b1': () => {
            requests += 1;
            return requests === 1
              ? json(broadcast({ name: 'Cached message', state: 'draft', startedAt: null }))
              : response.promise;
          },
          '/api/v1/templates/t1': (url) => {
            templateScopes.push(url.searchParams.get('orgId'));
            return json(templateDetail({ id: 't1', orgId: null, name: 'Copper card' }));
          },
        },
      });
      expect(await screen.findByRole('heading', { name: 'Cached message' })).toBeInTheDocument();
      await screen.findByText('Copper card');
      expect(templateScopes).toContain(messageOrg.id);
      expect(templateScopes).not.toContain(null);
      const initialTemplates = templateScopes.length;
      await act(async () => {
        await router.navigate({
          to: '/admin/messages/$broadcastId',
          params: { broadcastId: 'b1' },
          search: { orgId: undefined },
        });
      });
      await waitFor(() => expect(requests).toBe(2));
      expect(screen.queryByText('Cached message')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
      expect(new URLSearchParams(router.state.location.searchStr).has('orgId')).toBe(false);
      expect(localStorage.getItem('wallet-org-filter')).toBe(messageOrg.id);
      expect(templateScopes).toHaveLength(initialTemplates);

      await act(async () => {
        response.resolve(
          outcome === 'moved'
            ? json(
                broadcast({
                  orgId: otherMembership.orgId,
                  name: 'Moved message',
                  state: 'draft',
                  startedAt: null,
                }),
              )
            : problem(404, 'not_found', 'Message not found.'),
        );
        await response.promise;
      });
      if (outcome === 'moved') {
        expect(await screen.findByRole('heading', { name: 'Moved message' })).toBeInTheDocument();
        await waitFor(() => expect(router.state.location.search.orgId).toBe(otherMembership.orgId));
        expect(localStorage.getItem('wallet-org-filter')).toBe(otherMembership.orgId);
        await waitFor(() => expect(templateScopes).toContain(otherMembership.orgId));
      } else {
        expect(await screen.findByText('Message not found')).toBeInTheDocument();
        expect(new URLSearchParams(router.state.location.searchStr).has('orgId')).toBe(false);
        expect(localStorage.getItem('wallet-org-filter')).toBe(messageOrg.id);
        expect(screen.queryByText('Cached message')).not.toBeInTheDocument();
      }
    },
  );

  it('masks a bare message link when its actual organization is not a membership', async () => {
    localStorage.setItem('wallet-org-filter', messageOrg.id);
    const dependent: string[] = [];
    await renderApp('/admin/messages/b1', {
      session: 'admin',
      memberships: orgAccess.memberships,
      handlers: {
        '/api/v1/broadcasts/b1': () =>
          json(broadcast({ orgId: otherMembership.orgId, name: 'Private message' })),
        '/api/v1/templates/t1': () => {
          dependent.push('template');
          return json(templateDetail({ id: 't1', orgId: otherMembership.orgId }));
        },
        '/api/v1/broadcasts/b1/items': () => {
          dependent.push('items');
          return json({ items: [], nextCursor: null });
        },
      },
    });
    expect(await screen.findByText('Message not found')).toBeInTheDocument();
    expect(screen.queryByText('Private message')).not.toBeInTheDocument();
    expect(dependent).toEqual([]);
  });

  it.each(['draft', 'failed', 'sending'] as const)(
    'does not reveal or act on a %s broadcast from another selected organization',
    async (state) => {
      const unexpected: string[] = [];
      let detailRequests = 0;
      const { queryClient } = await renderApp('/admin/messages/b1', {
        session: 'admin',
        memberships: [...orgAccess.memberships, otherMembership],
        selectedOrg: messageOrg.id,
        handlers: {
          ...base,
          '/api/v1/broadcasts/b1': () => {
            detailRequests += 1;
            return json(
              broadcast({
                orgId: otherMembership.orgId,
                name: 'Private broadcast',
                patch: { message: 'Private content' },
                state,
              }),
            );
          },
          '/api/v1/templates/t1': () => {
            unexpected.push('template');
            return json(templateDetail({ id: 't1', orgId: otherMembership.orgId }));
          },
          '/api/v1/broadcasts/b1/items': () => {
            unexpected.push('items');
            return json({ items: [item()], nextCursor: null });
          },
          '/api/v1/broadcasts/preview': () => {
            unexpected.push('preview');
            return json({ targeted: 3, onDevice: 2, overBudget: 1, limit: 3 });
          },
          '/api/v1/broadcasts/b1/send': () => {
            unexpected.push('send');
            return json(broadcast());
          },
          '/api/v1/broadcasts/b1/retry': () => {
            unexpected.push('retry');
            return json(broadcast());
          },
          '/api/v1/broadcasts/b1/cancel': () => {
            unexpected.push('cancel');
            return json(broadcast());
          },
        },
      });

      expect(await screen.findByText('Message not found')).toBeInTheDocument();
      expect(detailRequests).toBeGreaterThan(0);
      const initialDetailRequests = detailRequests;
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ['admin', 'broadcasts', 'detail', 'b1'] });
      });
      expect(detailRequests).toBe(initialDetailRequests);
      expect(screen.queryByText('Private broadcast')).not.toBeInTheDocument();
      expect(screen.queryByText('Private content')).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Edit' })).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /^(Send|Send again|Cancel message)$/ }),
      ).not.toBeInTheDocument();
      expect(unexpected).toEqual([]);
    },
  );

  it('hides the cached message and open confirmation when the organization changes', async () => {
    const sent: string[] = [];
    const { router, queryClient } = await renderApp('/admin/messages/b1', {
      session: 'admin',
      memberships: [...orgAccess.memberships, otherMembership],
      selectedOrg: otherMembership.orgId,
      handlers: {
        ...base,
        '/api/v1/templates/t1': () =>
          json(templateDetail({ id: 't1', orgId: otherMembership.orgId, name: 'Harbor card' })),
        '/api/v1/broadcasts/b1': () =>
          json(
            broadcast({
              orgId: otherMembership.orgId,
              name: 'Private draft',
              patch: { message: 'Private content' },
              state: 'draft',
              startedAt: null,
            }),
          ),
        '/api/v1/broadcasts/b1/send': (url) => {
          sent.push(url.pathname);
          return json(broadcast());
        },
      },
    });
    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'Private draft' })).toBeInTheDocument();
    expect(
      screen.getByText('Organization', { selector: 'dt' }).nextElementSibling,
    ).toHaveTextContent('Harbor');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(
      await screen.findByRole('alertdialog', { name: 'Send to 3 passes?' }),
    ).toBeInTheDocument();

    await act(async () => {
      await router.navigate({
        to: '/admin/messages/$broadcastId',
        params: { broadcastId: 'b1' },
        search: { orgId: messageOrg.id },
      });
    });
    expect(await screen.findByText('Message not found')).toBeInTheDocument();
    expect(queryClient.getQueryData(['admin', 'broadcasts', 'detail', 'b1'])).toMatchObject({
      orgId: otherMembership.orgId,
      name: 'Private draft',
    });
    expect(screen.queryByText('Private draft')).not.toBeInTheDocument();
    expect(screen.queryByText('Private content')).not.toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
    expect(sent).toEqual([]);

    await act(async () => {
      await router.navigate({
        to: '/admin/messages/$broadcastId',
        params: { broadcastId: 'b1' },
        search: { orgId: otherMembership.orgId },
      });
    });
    expect(await screen.findByRole('heading', { name: 'Private draft' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it.each(['draft', 'scheduled', 'failed'] as const)(
    'shows a %s message without mutation controls to a read-only member',
    async (state) => {
      const actions: string[] = [];
      await renderApp('/admin/messages/b1', {
        session: 'user',
        memberships: [
          membershipFixture(messageOrg.id, {
            orgName: messageOrg.name,
            orgSlug: messageOrg.slug,
            capabilities: ['messages:read', 'passes:operate'],
          }),
        ],
        selectedOrg: messageOrg.id,
        handlers: {
          ...base,
          '/api/v1/broadcasts/b1': () => json(broadcast({ state })),
          '/api/v1/broadcasts/b1/items': () => json({ items: [], nextCursor: null }),
          '/api/v1/broadcasts/preview': () => {
            actions.push('preview');
            return json({ targeted: 3, onDevice: 2, overBudget: 1, limit: 3 });
          },
          '/api/v1/broadcasts/b1/send': () => {
            actions.push('send');
            return json(broadcast());
          },
          '/api/v1/broadcasts/b1/retry': () => {
            actions.push('retry');
            return json(broadcast());
          },
          '/api/v1/broadcasts/b1/cancel': () => {
            actions.push('cancel');
            return json(broadcast());
          },
        },
      });
      expect(await screen.findByRole('heading', { name: 'Doors open late' })).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Edit' })).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /^(Send|Send again|Cancel message)$/ }),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(actions).toEqual([]);
    },
  );

  it('closes an open send confirmation when operation capability is removed', async () => {
    const { queryClient } = await renderApp('/admin/messages/b1', {
      session: 'admin',
      ...orgAccess,
      handlers: {
        ...base,
        '/api/v1/broadcasts/b1': () => json(broadcast({ state: 'draft', startedAt: null })),
      },
    });
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Send' }));
    expect(
      await screen.findByRole('alertdialog', { name: 'Send to 3 passes?' }),
    ).toBeInTheDocument();
    await act(async () => {
      queryClient.setQueryData(['org-memberships', 'me'], {
        items: [
          membershipFixture(messageOrg.id, {
            orgName: messageOrg.name,
            orgSlug: messageOrg.slug,
            capabilities: ['messages:read', 'passes:operate'],
          }),
        ],
      });
    });
    expect(await screen.findByRole('heading', { name: 'Doors open late' })).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it.each(['admin', 'user'] as const)(
    'sends a draft as %s after the audience count, noting passes at the daily limit',
    async (session) => {
      const sent: unknown[] = [];
      await renderApp('/admin/messages/b1', {
        session,
        memberships: [
          membershipFixture(messageOrg.id, {
            orgName: messageOrg.name,
            orgSlug: messageOrg.slug,
            capabilities: ['messages:read', 'messages:manage', 'templates:read'],
          }),
        ],
        selectedOrg: messageOrg.id,
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
      expect(
        within(dialog).getByText('Eligible passes may receive a notification.'),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByText('1 pass is at the daily limit and updates quietly.'),
      ).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: 'Send' }));
      await waitFor(() => expect(sent).toEqual([{}]));
    },
  );

  it('shows a failed send inside the confirm', async () => {
    await renderApp('/admin/messages/b1', {
      session: 'admin',
      ...orgAccess,
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

  it('opens a draft in the composer and cancels it: it moves to Cancelled', async () => {
    const cancelled: string[] = [];
    const { router } = await renderApp('/admin/messages/b1', {
      session: 'admin',
      ...orgAccess,
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
    const edit = await screen.findByRole('link', { name: 'Edit' });
    const editUrl = new URL(edit.getAttribute('href') ?? '', 'http://localhost');
    expect(editUrl.pathname).toBe('/admin/messages/new');
    expect(editUrl.searchParams.get('from')).toBe('b1');
    if (editUrl.searchParams.has('orgId'))
      expect(editUrl.searchParams.get('orgId')).toBe(messageOrg.id);
    await user.click(screen.getByRole('button', { name: 'Cancel message' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Cancel Doors open late?' });
    expect(within(dialog).getByText('It moves to Cancelled. No pass changes.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Keep it' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel message' }));
    await waitFor(() => expect(cancelled).toEqual(['/api/v1/broadcasts/b1/cancel']));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/messages'));
  });

  it('calls a scheduled change off with "change" wording', async () => {
    await renderApp('/admin/messages/b1', {
      session: 'admin',
      ...orgAccess,
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
      ...orgAccess,
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

  it.each(['scope', 'capability'] as const)(
    'does not navigate when a retry finishes after the %s changes',
    async (change) => {
      const deferred = Promise as PromiseConstructor & {
        withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
      };
      const retry = deferred.withResolvers<Response>();
      const writes: string[] = [];
      const { router, queryClient } = await renderApp('/admin/messages/b1', {
        session: 'user',
        memberships: [...orgAccess.memberships, otherMembership],
        selectedOrg: messageOrg.id,
        handlers: {
          ...base,
          '/api/v1/broadcasts': () => json({ items: [], nextCursor: null }),
          '/api/v1/broadcasts/b1': () =>
            json(broadcast({ state: 'failed', errorCode: 'BROADCAST_FAILED' })),
          '/api/v1/broadcasts/b1/items': () => json({ items: [], nextCursor: null }),
          '/api/v1/broadcasts/b1/retry': () => {
            writes.push('retry');
            return retry.promise;
          },
          '/api/v1/broadcasts/b2': () => json(broadcast({ id: 'b2', state: 'sending' })),
        },
      });
      await userEvent.setup().click(await screen.findByRole('button', { name: 'Send again' }));
      await waitFor(() => expect(writes).toEqual(['retry']));
      if (change === 'scope') {
        await act(async () => {
          await router.navigate({
            to: '/admin/messages',
            search: { orgId: otherMembership.orgId },
          });
        });
      } else {
        await act(async () => {
          queryClient.setQueryData(['org-memberships', 'me'], {
            items: [
              membershipFixture(messageOrg.id, {
                orgName: messageOrg.name,
                orgSlug: messageOrg.slug,
                capabilities: ['messages:read'],
              }),
              otherMembership,
            ],
          });
        });
      }
      const path = router.state.location.pathname;
      await act(async () => {
        retry.resolve(json(broadcast({ id: 'b2', state: 'sending' })));
        await retry.promise;
      });
      await waitFor(() => expect(queryClient.isMutating()).toBe(0));
      expect(router.state.location.pathname).toBe(path);
    },
  );

  it('does not offer Send again in another mode', async () => {
    await renderApp('/admin/messages/b1', {
      session: 'admin',
      ...orgAccess,
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
      ...orgAccess,
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
    const syncUrl = new URL(link.getAttribute('href') ?? '', 'http://localhost');
    expect(syncUrl.pathname).toBe('/admin/passes/pass-0001');
    expect(syncUrl.searchParams.get('tab')).toBe('sync');
    if (syncUrl.searchParams.has('orgId'))
      expect(syncUrl.searchParams.get('orgId')).toBe(messageOrg.id);
    expect(screen.getByText('Silent (daily limit)')).toBeInTheDocument();
  });

  it('names a change by the template label, not its key', async () => {
    await renderApp('/admin/messages/b1', {
      session: 'admin',
      ...orgAccess,
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

  it('does not expose a foreign template returned for an authorized message', async () => {
    const { queryClient } = await renderApp('/admin/messages/b1', {
      session: 'admin',
      ...orgAccess,
      handlers: {
        ...base,
        '/api/v1/broadcasts/b1': () =>
          json(broadcast({ kind: 'change', patch: { level: 'blue' } })),
        '/api/v1/broadcasts/b1/items': () => json({ items: [], nextCursor: null }),
        '/api/v1/templates/t1': () =>
          json(
            templateDetail({
              id: 't1',
              orgId: otherMembership.orgId,
              name: 'Private template',
              inputSchema: {
                type: 'object',
                properties: { level: { type: 'string', 'x-label': 'Secret tenant label' } },
              },
            }),
          ),
      },
    });
    expect(await screen.findByRole('heading', { name: 'Doors open late' })).toBeInTheDocument();
    await waitFor(() =>
      expect(
        queryClient.getQueryState(['admin', 'templates', 'detail', 't1', messageOrg.id])?.status,
      ).toBe('success'),
    );
    expect(screen.queryByText('Private template')).not.toBeInTheDocument();
    expect(screen.queryByText('Secret tenant label')).not.toBeInTheDocument();
    expect(screen.getByText('level')).toBeInTheDocument();
  });

  it('keeps the page when a poll fails', async () => {
    let calls = 0;
    const { queryClient } = await renderApp('/admin/messages/b1', {
      session: 'admin',
      ...orgAccess,
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
