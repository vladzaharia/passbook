import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, membershipFixture, renderApp, sessionFixture } from '@/web/lib/test-utils.tsx';

const reader = membershipFixture('o1', {
  orgName: 'North',
  roles: ['read_only'],
  capabilities: ['org:read', 'integrations:read'],
});
const manager = membershipFixture('o1', {
  orgName: 'North',
  roles: ['integration_admin'],
  capabilities: ['org:read', 'integrations:read', 'integrations:manage'],
});
const key = (id: string, orgId: string | null, name: string, revokedAt: number | null = null) => ({
  id,
  orgId,
  name,
  prefix: id,
  scopes: ['passes:read'],
  mode: 'live',
  createdBy: null,
  createdByName: null,
  createdAt: 1_700_000_000_000,
  lastUsedAt: null,
  expiresAt: null,
  revokedAt,
});
const page = (items: unknown[], revokedCount = 0) =>
  json({ items, nextCursor: null, revokedCount });

afterEach(() => vi.unstubAllGlobals());

describe('API key platform and membership authority', () => {
  it('denies a non-platform member even with integration management and an explicit org', async () => {
    const requests = vi.fn(() => page([]));
    await renderApp('/admin/api-keys?orgId=o1&new=1', {
      session: 'user',
      memberships: [manager],
      handlers: { '/api/v1/api-keys': requests },
    });
    expect(
      await screen.findByRole('heading', { name: 'You do not have access' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'New API key' })).toBeNull();
    expect(requests).not.toHaveBeenCalled();
  });

  it('lets an admin without memberships list and revoke platform keys', async () => {
    const requests: { method: string; orgId: string | null }[] = [];
    await renderApp('/admin/api-keys', {
      session: 'admin',
      memberships: [],
      handlers: {
        '/api/v1/api-keys': (url, init) => {
          requests.push({ method: init?.method ?? 'GET', orgId: url.searchParams.get('orgId') });
          return page([key('global', null, 'Platform key'), key('foreign', 'o2', 'Foreign key')]);
        },
        '/api/v1/api-keys/global': (url, init) => {
          requests.push({ method: init?.method ?? 'GET', orgId: url.searchParams.get('orgId') });
          return json({ ok: true });
        },
      },
    });
    const user = userEvent.setup();
    expect(await screen.findByText('Platform key')).toBeInTheDocument();
    expect(screen.queryByText('Foreign key')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Actions for Platform key' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Revoke' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Revoke' }),
    );
    await waitFor(() => expect(requests).toContainEqual({ method: 'DELETE', orgId: 'null' }));
    expect(requests.every((request) => request.orgId === 'null')).toBe(true);
  });

  it('does not query an explicit organization without membership or fall back to a remembered one', async () => {
    vi.stubGlobal('localStorage', {
      getItem: (name: string) => (name === 'wallet-org-filter' ? 'o1' : null),
      setItem: () => {},
      removeItem: () => {},
    });
    const requests = vi.fn(() => page([]));
    await renderApp('/admin/api-keys?orgId=o2&new=1', {
      session: 'admin',
      memberships: [manager],
      handlers: { '/api/v1/api-keys': requests },
    });
    expect(
      await screen.findByRole('heading', { name: 'You do not have access' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'New API key' })).toBeNull();
    expect(requests).not.toHaveBeenCalled();
  });

  it('only shows read actions for a platform admin with read-only membership', async () => {
    const seen: (string | null)[] = [];
    await renderApp('/admin/api-keys?orgId=o1&new=1', {
      session: 'admin',
      memberships: [reader],
      handlers: {
        '/api/v1/api-keys': (url) => {
          seen.push(url.searchParams.get('orgId'));
          return page([key('north', 'o1', 'North key'), key('global', null, 'Platform key')]);
        },
      },
    });
    expect(await screen.findByText('North key')).toBeInTheDocument();
    expect(screen.queryByText('Platform key')).toBeNull();
    expect(screen.queryByRole('button', { name: 'New API key' })).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'New API key' })).toBeNull();
    // A read-only row has one action, shown as a button rather than a menu.
    expect(screen.getByRole('button', { name: 'Copy prefix' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Actions for|Revoke/ })).toBeNull();
    expect(seen.every((orgId) => orgId === 'o1')).toBe(true);
  });

  it('revokes in the selected membership and can return to platform-wide keys', async () => {
    const reads: (string | null)[] = [];
    let revokeOrg: string | null | undefined;
    const { router } = await renderApp('/admin/api-keys?orgId=o1', {
      session: 'admin',
      memberships: [manager],
      handlers: {
        '/api/v1/api-keys': (url) => {
          reads.push(url.searchParams.get('orgId'));
          return page([
            key('north', 'o1', 'North key'),
            key('global', null, 'Platform key'),
            key('other', 'o2', 'Other key'),
          ]);
        },
        '/api/v1/api-keys/north': (url, init) => {
          if (init?.method === 'DELETE') revokeOrg = url.searchParams.get('orgId');
          return json({ ok: true });
        },
      },
    });
    const user = userEvent.setup();
    expect(await screen.findByText('North key')).toBeInTheDocument();
    expect(screen.queryByText('Platform key')).toBeNull();
    expect(screen.queryByText('Other key')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Actions for North key' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Revoke' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Revoke' }),
    );
    await waitFor(() => expect(revokeOrg).toBe('o1'));
    await user.click(screen.getByRole('combobox', { name: 'Key context' }));
    await user.click(await screen.findByRole('option', { name: 'Platform-wide keys' }));
    await waitFor(() => expect(router.state.location.search.orgId).toBeUndefined());
    expect(await screen.findByText('Platform key')).toBeInTheDocument();
    expect(reads).toContain('o1');
    expect(reads).toContain('null');
    expect(reads).not.toContain('o2');
  });

  it('closes a pending review if organization manage authority is removed', async () => {
    const requests = vi.fn((_url: URL, _init: RequestInit | undefined) =>
      page([key('north', 'o1', 'North key')]),
    );
    const { queryClient } = await renderApp('/admin/api-keys?orgId=o1', {
      session: 'admin',
      memberships: [manager],
      handlers: { '/api/v1/api-keys': requests },
    });
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole('button', { name: 'New API key' }))[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'New API key' });
    await user.type(within(dialog).getByLabelText(/Name/), 'Pending key');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Read passes' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(
      await screen.findByRole('alertdialog', { name: 'Review service key' }),
    ).toBeInTheDocument();
    act(() => {
      queryClient.setQueryData(['org-memberships', 'me'], { items: [reader] });
    });
    await waitFor(() =>
      expect(screen.queryByRole('alertdialog', { name: 'Review service key' })).toBeNull(),
    );
    expect(screen.queryByRole('button', { name: 'New API key' })).toBeNull();
    expect(requests.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
  });

  it('does not reuse rows or an open creation dialog after a principal change', async () => {
    const deferred = Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
    };
    const next = deferred.withResolvers<Response>();
    let calls = 0;
    const { queryClient } = await renderApp('/admin/api-keys', {
      session: 'admin',
      memberships: [],
      handlers: {
        '/api/v1/api-keys': () =>
          ++calls === 1 ? page([key('old', null, 'Old key')]) : next.promise,
      },
    });
    const user = userEvent.setup();
    expect(await screen.findByText('Old key')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'New API key' })[0]!);
    expect(await screen.findByRole('dialog', { name: 'New API key' })).toBeInTheDocument();
    const nextSession = sessionFixture('admin');
    if (!nextSession.authenticated) throw new Error('Expected an authenticated session fixture.');
    act(() => {
      queryClient.setQueryData(['session'], {
        ...nextSession,
        user: { ...nextSession.user, id: 'u2' },
      });
    });
    await waitFor(() => expect(calls).toBe(2));
    expect(screen.queryByText('Old key')).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'New API key' })).toBeNull();
    next.resolve(page([key('new', null, 'New key')]));
    expect(await screen.findByText('New key')).toBeInTheDocument();
  });
});
