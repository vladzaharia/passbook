import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrgMembership } from '@/shared/contracts/org-membership.ts';
import {
  CreateScanningSessionSchema,
  type ScanningSession,
} from '@/shared/contracts/scanning-sessions.ts';
import { resetModeForTests, setMode } from '@/web/lib/mode.ts';
import { AppProviders } from '@/web/lib/providers.tsx';
import { createQueryClient } from '@/web/lib/query-client.ts';
import {
  json,
  membershipFixture,
  problem,
  type SessionKind,
  sessionFixture,
  stubFetch,
} from '@/web/lib/test-utils.tsx';
import { eligibleTemplateFixture } from '../test-fixtures.ts';
import { NewSessionDialog, SessionRulesDialog } from './session-dialog.tsx';
import { managedSession } from './test-fixtures.ts';

const northwind = membershipFixture('o1', { orgName: 'Northwind' });
const harbor = membershipFixture('o2', { orgName: 'Harbor' });
const reader = membershipFixture('o3', {
  orgName: 'Read only',
  capabilities: ['org:read', 'scanning:read'],
});
const revoked = membershipFixture('o4', { orgName: 'Revoked', revokedAt: 1_700_000_000_001 });

afterEach(() => {
  resetModeForTests();
  vi.unstubAllGlobals();
  localStorage.removeItem('wallet-org-filter');
});

function setup({
  memberships = [northwind],
  orgId,
  kind = 'new',
  sessionKind = 'admin',
  initial,
  membershipResponse,
  eligibleTemplates = [],
}: {
  memberships?: OrgMembership[];
  orgId?: string;
  kind?: 'new' | 'rules';
  sessionKind?: SessionKind;
  initial?: ScanningSession;
  membershipResponse?: Promise<Response>;
  eligibleTemplates?: unknown[];
} = {}) {
  localStorage.removeItem('wallet-org-filter');
  const writes: { method: string; body: Record<string, unknown> }[] = [];
  const onCreated = vi.fn();
  const onClose = vi.fn();
  const save = (_url: URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    writes.push({ method: init?.method ?? '', body });
    return json({
      ...managedSession,
      id: kind === 'new' ? 'created' : managedSession.id,
    });
  };
  const fetchMock = stubFetch({
    '/api/v1/orgs/memberships/me': () => membershipResponse ?? json({ items: memberships }),
    '/api/v1/orgs': () => json({ items: [{ id: 'global', name: 'Global only' }] }),
    '/api/v1/templates/eligible': () => json({ items: eligibleTemplates, nextCursor: null }),
    '/api/v1/scan-events': () => json({ items: [], nextCursor: null }),
    '/api/v1/scanning-sessions': save,
    '/api/v1/scanning-sessions/session-1': save,
  });
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false, staleTime: 30_000 } });
  queryClient.setQueryData(['session'], sessionFixture(sessionKind));
  if (!membershipResponse) {
    queryClient.setQueryData(['org-memberships', 'me'], { items: memberships });
  }
  const root = createRootRoute({ component: Outlet });
  const scanning = createRoute({
    getParentRoute: () => root,
    path: '/admin/scanning',
    validateSearch: (search: Record<string, unknown>) => ({
      orgId: typeof search.orgId === 'string' ? search.orgId : undefined,
    }),
    component: () =>
      kind === 'rules' ? (
        <SessionRulesDialog session={managedSession} onClose={onClose} />
      ) : (
        <NewSessionDialog initial={initial} onClose={onClose} onCreated={onCreated} />
      ),
  });
  const router = createRouter({
    routeTree: root.addChildren([scanning]),
    history: createMemoryHistory({
      initialEntries: [
        orgId ? `/admin/scanning?orgId=${encodeURIComponent(orgId)}` : '/admin/scanning',
      ],
    }),
  });
  render(
    <AppProviders queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { router, queryClient, fetchMock, writes, onCreated, onClose };
}

function organization(dialog: HTMLElement) {
  return within(dialog).getByRole('combobox', { name: 'Organization' });
}

async function chooseOrg(dialog: HTMLElement, name: string) {
  const user = userEvent.setup();
  await user.click(organization(dialog));
  await user.click(await screen.findByRole('option', { name }));
}

function requestedDirectory(calls: readonly (readonly unknown[])[]) {
  return calls.some(
    ([url]) => new URL(String(url), 'http://localhost').pathname === '/api/v1/orgs',
  );
}

describe('session dialog organization authority', () => {
  it('does not select a sole membership until the user explicitly chooses it', async () => {
    const { router, writes, onCreated, fetchMock } = setup();
    const user = userEvent.setup();
    const dialog = await screen.findByRole('dialog', { name: 'New scanning session' });
    expect(organization(dialog)).toHaveTextContent('Select');
    expect(within(dialog).queryByRole('textbox', { name: 'Session name' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Create session' })).toBeDisabled();
    expect(router.state.location.search.orgId).toBeUndefined();
    expect(writes).toEqual([]);

    await chooseOrg(dialog, 'Northwind');
    await waitFor(() => expect(router.state.location.search.orgId).toBe('o1'));
    await user.type(await within(dialog).findByRole('textbox', { name: 'Session name' }), 'Entry');
    await user.click(within(dialog).getByRole('button', { name: 'Create session' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('created'));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ method: 'POST', body: { orgId: 'o1', name: 'Entry' } });
    expect(requestedDirectory(fetchMock.mock.calls)).toBe(false);
  });

  it.each(['admin', 'user'] as const)(
    'offers %s only active memberships with scanning management permission',
    async (sessionKind) => {
      const { fetchMock } = setup({
        memberships: [northwind, harbor, reader, revoked],
        orgId: 'o1',
        sessionKind,
      });
      const dialog = await screen.findByRole('dialog', { name: 'New scanning session' });
      const user = userEvent.setup();
      expect(organization(dialog)).toHaveTextContent('Northwind');
      await user.click(organization(dialog));
      expect(await screen.findByRole('option', { name: 'Northwind' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'Harbor' })).toBeInTheDocument();
      expect(screen.queryByRole('option', { name: 'Read only' })).not.toBeInTheDocument();
      expect(screen.queryByRole('option', { name: 'Revoked' })).not.toBeInTheDocument();
      expect(screen.queryByRole('option', { name: 'Global only' })).not.toBeInTheDocument();
      expect(requestedDirectory(fetchMock.mock.calls)).toBe(false);
    },
  );

  it('does not give a platform admin a tenant choice without a membership', async () => {
    const { fetchMock, writes } = setup({ memberships: [], orgId: 'o1' });
    const dialog = await screen.findByRole('dialog', { name: 'New scanning session' });
    expect(organization(dialog)).toHaveTextContent('Select');
    expect(within(dialog).getByRole('button', { name: 'Create session' })).toBeDisabled();
    expect(within(dialog).queryByRole('textbox', { name: 'Session name' })).not.toBeInTheDocument();
    expect(requestedDirectory(fetchMock.mock.calls)).toBe(false);
    expect(writes).toEqual([]);
  });

  it('does not fall back to the sole membership when the requested scope is unauthorized', async () => {
    const { router, writes } = setup({ orgId: 'not-a-membership' });
    const dialog = await screen.findByRole('dialog', { name: 'New scanning session' });
    expect(organization(dialog)).toHaveTextContent('Select');
    expect(within(dialog).getByRole('button', { name: 'Create session' })).toBeDisabled();
    expect(router.state.location.search.orgId).toBe('not-a-membership');
    expect(writes).toEqual([]);
    await chooseOrg(dialog, 'Northwind');
    await waitFor(() => expect(router.state.location.search.orgId).toBe('o1'));
    expect(
      await within(dialog).findByRole('textbox', { name: 'Session name' }),
    ).toBeInTheDocument();
  });

  it('allows a tenant manager without the platform admin role to create in the selected scope', async () => {
    const { writes, onCreated } = setup({ sessionKind: 'user', orgId: 'o1' });
    const dialog = await screen.findByRole('dialog', { name: 'New scanning session' });
    const user = userEvent.setup();
    await user.type(within(dialog).getByRole('textbox', { name: 'Session name' }), 'Tenant entry');
    await user.click(within(dialog).getByRole('button', { name: 'Create session' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('created'));
    expect(writes[0]).toMatchObject({
      method: 'POST',
      body: { orgId: 'o1', name: 'Tenant entry' },
    });
  });

  it('does not initialize from a selected membership lacking scanning management', async () => {
    const { router, writes } = setup({ memberships: [reader, harbor], orgId: 'o3' });
    const dialog = await screen.findByRole('dialog', { name: 'New scanning session' });
    expect(organization(dialog)).toHaveTextContent('Select');
    expect(within(dialog).getByRole('button', { name: 'Create session' })).toBeDisabled();
    await chooseOrg(dialog, 'Harbor');
    await waitFor(() => expect(router.state.location.search.orgId).toBe('o2'));
    expect(
      await within(dialog).findByRole('textbox', { name: 'Session name' }),
    ).toBeInTheDocument();
    expect(writes).toEqual([]);
  });

  it.each(['new', 'rules'] as const)(
    'refuses the %s action when memberships cannot be loaded',
    async (kind) => {
      const { queryClient, writes, fetchMock } = setup({
        kind,
        orgId: 'o1',
        membershipResponse: Promise.resolve(problem(403, 'forbidden', 'Membership access failed.')),
      });
      const dialog = await screen.findByRole('dialog', {
        name: kind === 'new' ? 'New scanning session' : 'Session rules',
      });
      await waitFor(() =>
        expect(queryClient.getQueryState(['org-memberships', 'me'])?.status).toBe('error'),
      );
      expect(
        within(dialog).getByRole('button', {
          name: kind === 'new' ? 'Create session' : 'Save session',
        }),
      ).toBeDisabled();
      expect(
        within(dialog).queryByRole('textbox', { name: 'Session name' }),
      ).not.toBeInTheDocument();
      expect(requestedDirectory(fetchMock.mock.calls)).toBe(false);
      expect(writes).toEqual([]);
    },
  );

  it('initializes a duplicate from the selected membership after it loads', async () => {
    // The web test target is ES2023, which does not expose Promise.withResolvers.
    let resolveMembership!: (response: Response) => void;
    const membershipResponse = new Promise<Response>((resolve) => {
      resolveMembership = resolve;
    });
    const initial = {
      ...managedSession,
      accepts: { eventId: 'event-1' },
      settings: {
        ...managedSession.settings,
        checkIn: { mode: 'in_out' as const, eventId: 'event-1' },
      },
    };
    const { writes } = setup({ initial, orgId: 'o1', membershipResponse });
    const dialog = await screen.findByRole('dialog', { name: 'Duplicate session' });
    expect(within(dialog).getByRole('button', { name: 'Create session' })).toBeDisabled();
    await act(async () => resolveMembership(json({ items: [northwind] })));
    expect(await within(dialog).findByRole('textbox', { name: 'Session name' })).toHaveValue(
      'Membership desk copy',
    );
    expect(within(dialog).getByRole('radio', { name: 'Event' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(within(dialog).getByRole('button', { name: 'Create session' })).toBeEnabled();
    expect(writes).toEqual([]);
  });

  it('synchronizes a picker change and clears the old event restrictions', async () => {
    const initial = {
      ...managedSession,
      accepts: { eventId: 'event-1' },
      settings: {
        ...managedSession.settings,
        checkIn: { mode: 'in_out' as const, eventId: 'event-1' },
      },
    };
    const { router, writes, onCreated, fetchMock } = setup({
      memberships: [northwind, harbor],
      orgId: 'o1',
      initial,
    });
    const user = userEvent.setup();
    const dialog = await screen.findByRole('dialog', { name: 'Duplicate session' });
    await chooseOrg(dialog, 'Harbor');
    await waitFor(() => expect(router.state.location.search.orgId).toBe('o2'));
    await waitFor(() => expect(organization(dialog)).toHaveTextContent('Harbor'));
    expect(within(dialog).getByRole('button', { name: 'Create session' })).toBeDisabled();
    await user.click(within(dialog).getByRole('radio', { name: 'All passes' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create session' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('created'));
    expect(writes[0]).toMatchObject({
      method: 'POST',
      body: { orgId: 'o2', accepts: null, settings: { checkIn: { mode: 'in_out' } } },
    });
    const body = CreateScanningSessionSchema.parse(writes[0]?.body);
    expect(body.settings?.checkIn).not.toHaveProperty('eventId');
    const eventRequests = fetchMock.mock.calls
      .map(([url]) => new URL(String(url), 'http://localhost'))
      .filter((url) => url.pathname === '/api/v1/scan-events');
    expect(eventRequests.every((url) => Boolean(url.searchParams.get('orgId')))).toBe(true);
  });

  it('clears eligible template selections when the picker changes organizations', async () => {
    const { router, writes, onCreated, fetchMock } = setup({
      memberships: [northwind, harbor],
      orgId: 'o1',
      eligibleTemplates: [
        eligibleTemplateFixture(),
        eligibleTemplateFixture({
          templateId: 't2',
          name: 'Harbor ticket',
          templateOrgId: 'o2',
          releaseId: 'release-2',
        }),
      ],
    });
    const user = userEvent.setup();
    const dialog = await screen.findByRole('dialog', { name: 'New scanning session' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Session name' }), 'Entry');
    await user.click(within(dialog).getByRole('radio', { name: 'Templates' }));
    await user.click(await within(dialog).findByRole('checkbox', { name: 'Gala ticket' }));
    expect(
      within(dialog).queryByRole('checkbox', { name: 'Harbor ticket' }),
    ).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Create session' })).toBeEnabled();

    await chooseOrg(dialog, 'Harbor');
    await waitFor(() => expect(router.state.location.search.orgId).toBe('o2'));
    const harborTicket = await within(dialog).findByRole('checkbox', { name: 'Harbor ticket' });
    expect(within(dialog).queryByRole('checkbox', { name: 'Gala ticket' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Create session' })).toBeDisabled();
    await user.click(harborTicket);
    await user.click(within(dialog).getByRole('button', { name: 'Create session' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('created'));
    expect(writes[0]).toMatchObject({
      method: 'POST',
      body: { orgId: 'o2', accepts: { templateIds: ['t2'] } },
    });
    const requests = fetchMock.mock.calls
      .map(([url]) => new URL(String(url), 'http://localhost'))
      .filter((url) => url.pathname === '/api/v1/templates/eligible');
    expect(requests.map((url) => url.searchParams.get('orgId'))).toEqual(
      expect.arrayContaining(['o1', 'o2']),
    );
    expect(requests.every((url) => url.searchParams.get('mode') === 'live')).toBe(true);
  });

  it('pins a new draft to its opening mode and restores its selections on switching back', async () => {
    const { writes, onCreated } = setup({
      orgId: 'o1',
      eligibleTemplates: [eligibleTemplateFixture()],
    });
    const user = userEvent.setup();
    const dialog = await screen.findByRole('dialog', { name: 'New scanning session' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Session name' }), 'Entry');
    await user.click(within(dialog).getByRole('radio', { name: 'Templates' }));
    await user.click(await within(dialog).findByRole('checkbox', { name: 'Gala ticket' }));
    expect(within(dialog).getByRole('button', { name: 'Create session' })).toBeEnabled();

    act(() => setMode('test'));
    expect(
      await within(dialog).findByText('Switch to Live mode to create this session.'),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole('checkbox', { name: 'Gala ticket' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Create session' })).toBeDisabled();
    expect(writes).toEqual([]);

    act(() => setMode('live'));
    expect(await within(dialog).findByRole('checkbox', { name: 'Gala ticket' })).toBeChecked();
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Create session' })).toBeEnabled(),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Create session' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('created'));
    expect(writes[0]).toMatchObject({ body: { orgId: 'o1', accepts: { templateIds: ['t1'] } } });
  });

  it('pins a duplicate to the source session mode even when opened in another mode', async () => {
    act(() => setMode('test'));
    const { writes, onCreated } = setup({ orgId: 'o1', initial: managedSession });
    const dialog = await screen.findByRole('dialog', { name: 'Duplicate session' });
    expect(
      await within(dialog).findByText('Switch to Live mode to create this session.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Create session' })).toBeDisabled();
    expect(writes).toEqual([]);

    act(() => setMode('live'));
    expect(await within(dialog).findByRole('textbox', { name: 'Session name' })).toHaveValue(
      'Membership desk copy',
    );
    const user = userEvent.setup();
    await user.click(within(dialog).getByRole('button', { name: 'Create session' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('created'));
    expect(writes[0]).toMatchObject({ body: { orgId: 'o1' } });
  });

  it.each(['capability', 'revoked', 'removed'] as const)(
    'refuses a create draft after membership %s',
    async (change) => {
      const { queryClient, writes } = setup({ memberships: [northwind, harbor], orgId: 'o1' });
      const user = userEvent.setup();
      const dialog = await screen.findByRole('dialog', { name: 'New scanning session' });
      await user.type(within(dialog).getByRole('textbox', { name: 'Session name' }), 'Entry');
      expect(within(dialog).getByRole('button', { name: 'Create session' })).toBeEnabled();
      const changed =
        change === 'removed'
          ? []
          : [
              change === 'revoked'
                ? { ...northwind, revokedAt: 1_700_000_000_001 }
                : { ...northwind, capabilities: ['org:read', 'scanning:read'] },
            ];
      act(() => {
        queryClient.setQueryData(['org-memberships', 'me'], { items: [...changed, harbor] });
      });
      await waitFor(() =>
        expect(within(dialog).getByRole('button', { name: 'Create session' })).toBeDisabled(),
      );
      expect(
        within(dialog).queryByRole('textbox', { name: 'Session name' }),
      ).not.toBeInTheDocument();
      expect(writes).toEqual([]);
    },
  );

  it('does not follow an external scope switch with an existing create draft', async () => {
    const { router, writes } = setup({ memberships: [northwind, harbor], orgId: 'o1' });
    const user = userEvent.setup();
    const dialog = await screen.findByRole('dialog', { name: 'New scanning session' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Session name' }), 'Entry');
    await act(async () => {
      await router.navigate({ to: '/admin/scanning', search: { orgId: 'o2' } });
    });
    expect(within(dialog).getByRole('button', { name: 'Create session' })).toBeDisabled();
    expect(within(dialog).queryByRole('textbox', { name: 'Session name' })).not.toBeInTheDocument();
    expect(writes).toEqual([]);
    await chooseOrg(dialog, 'Northwind');
    await waitFor(() => expect(router.state.location.search.orgId).toBe('o1'));
    expect(await within(dialog).findByRole('textbox', { name: 'Session name' })).toHaveValue(
      'Entry',
    );
    await act(async () => {
      await router.navigate({ to: '/admin/scanning', search: { orgId: 'o2' } });
    });
    await chooseOrg(dialog, 'Harbor');
    expect(await within(dialog).findByRole('textbox', { name: 'Session name' })).toHaveValue(
      'Entry',
    );
    expect(within(dialog).getByRole('button', { name: 'Create session' })).toBeEnabled();
  });

  it('edits only the session’s actual selected organization', async () => {
    const { router, writes, onClose } = setup({
      kind: 'rules',
      memberships: [northwind, harbor],
      orgId: 'o2',
    });
    const dialog = await screen.findByRole('dialog', { name: 'Session rules' });
    expect(within(dialog).queryByRole('textbox', { name: 'Session name' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Save session' })).toBeDisabled();
    await act(async () => {
      await router.navigate({ to: '/admin/scanning', search: { orgId: 'o1' } });
    });
    const user = userEvent.setup();
    const name = await within(dialog).findByRole('textbox', { name: 'Session name' });
    await user.clear(name);
    await user.type(name, 'Updated');
    await user.click(within(dialog).getByRole('button', { name: 'Save session' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      method: 'PATCH',
      body: { name: 'Updated', revision: managedSession.updatedAt },
    });
    expect(writes[0]?.body).not.toHaveProperty('orgId');
  });

  it('does not edit or save a session using another console mode', async () => {
    const { writes, onClose } = setup({ kind: 'rules', orgId: 'o1' });
    const user = userEvent.setup();
    const dialog = await screen.findByRole('dialog', { name: 'Session rules' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Session name' }), ' updated');
    expect(within(dialog).getByRole('button', { name: 'Save session' })).toBeEnabled();

    act(() => setMode('test'));
    expect(
      await within(dialog).findByText('Switch to Live mode to edit this session.'),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole('textbox', { name: 'Session name' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Save session' })).toBeDisabled();
    expect(writes).toEqual([]);

    act(() => setMode('live'));
    expect(await within(dialog).findByRole('textbox', { name: 'Session name' })).toHaveValue(
      'Membership desk updated',
    );
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Save session' })).toBeEnabled(),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Save session' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(writes[0]).toMatchObject({ method: 'PATCH', body: { name: 'Membership desk updated' } });
  });

  it.each(['capability', 'revoked', 'removed', 'scope'] as const)(
    'refuses an edit draft after %s changes',
    async (change) => {
      const { router, queryClient, writes } = setup({
        kind: 'rules',
        memberships: [northwind, harbor],
        orgId: 'o1',
      });
      const user = userEvent.setup();
      const dialog = await screen.findByRole('dialog', { name: 'Session rules' });
      await user.type(within(dialog).getByRole('textbox', { name: 'Session name' }), ' updated');
      expect(within(dialog).getByRole('button', { name: 'Save session' })).toBeEnabled();
      if (change === 'scope') {
        await act(async () => {
          await router.navigate({ to: '/admin/scanning', search: { orgId: 'o2' } });
        });
      } else {
        const changed =
          change === 'removed'
            ? []
            : [
                change === 'revoked'
                  ? { ...northwind, revokedAt: 1_700_000_000_001 }
                  : { ...northwind, capabilities: ['org:read', 'scanning:read'] },
              ];
        act(() => {
          queryClient.setQueryData(['org-memberships', 'me'], { items: [...changed, harbor] });
        });
      }
      await waitFor(() =>
        expect(within(dialog).getByRole('button', { name: 'Save session' })).toBeDisabled(),
      );
      expect(
        within(dialog).queryByRole('textbox', { name: 'Session name' }),
      ).not.toBeInTheDocument();
      expect(writes).toEqual([]);
    },
  );
});
