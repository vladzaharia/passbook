import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { resetModeForTests } from '@/web/lib/mode.ts';
import { json, membershipFixture, problem, renderApp } from '@/web/lib/test-utils.tsx';
import { memoryStorage, northwind, otherHandlers, person } from './staff-test-fixtures.ts';

beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
afterEach(() => {
  resetModeForTests();
  vi.unstubAllGlobals();
});

describe('Scanning staff', () => {
  it('shows staff read-only without create, edit, PIN, or status actions', async () => {
    await renderApp('/admin/scanning?tab=staff', {
      session: 'admin',
      memberships: [
        membershipFixture('o1', {
          orgName: 'Northwind',
          orgSlug: 'northwind',
          roles: ['read_only'],
          capabilities: ['org:read', 'scanning:read'],
        }),
      ],
      selectedOrg: 'o1',
      handlers: {
        ...otherHandlers,
        '/api/v1/scan-staff': () =>
          json({
            items: [person(), person({ id: 'foreign', orgId: 'o2', name: 'Private staff' })],
          }),
      },
    });
    expect(await screen.findByText('Sam K.')).toBeInTheDocument();
    expect(screen.queryByText('Private staff')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add staff' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Actions for Sam K.' })).not.toBeInTheDocument();
  });

  it('requires an authorized organization before fetching or offering changes', async () => {
    const { fetchMock } = await renderApp('/admin/scanning?tab=staff', {
      session: 'admin',
      memberships: [northwind],
      handlers: {
        ...otherHandlers,
        '/api/v1/scan-staff': () => json({ items: [] }),
        '/api/v1/orgs': () =>
          json({
            items: [
              {
                id: 'other',
                name: 'Directory only',
                slug: 'other',
                status: 'active',
                defaultIdentityId: null,
                branding: {},
                createdAt: 1,
                updatedAt: 1,
                counts: { passes: 0, templates: 0, connections: 0, apiKeys: 0 },
                countsCapped: false,
              },
            ],
            nextCursor: null,
          }),
      },
    });
    expect(
      await screen.findByRole('heading', { name: 'Choose an organization', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add staff' })).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([url]) =>
        /^\/api\/v1\/(?:scan-staff|scan-setups|scan-events|scanning-sessions)(?:\?|$)/.test(
          String(url),
        ),
      ),
    ).toBe(false);

    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: /^Organization filter/ }));
    expect(screen.queryByRole('option', { name: 'Directory only' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'All organizations' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('option', { name: 'Northwind' }));
    expect(await screen.findByText('No staff yet')).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([url]) => String(url) === '/api/v1/scan-staff?orgId=o1&limit=50'),
    ).toBe(true);
  });

  it('shows loading, then active and disabled staff with only real scanner locks and activity', async () => {
    // The web build targets ES2023; the test runtime provides withResolvers.
    const deferred = Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
    };
    const list = deferred.withResolvers<Response>();
    const sam = person({
      today: 12,
      locked: true,
      lastScan: { at: Date.now() - 60_000, scannerName: 'Front door' },
    });
    const jo = person({ id: 'staff-2', name: 'Jo', role: 'manager', disabledAt: Date.now() });
    const { container, fetchMock } = await renderApp('/admin/scanning?tab=staff&orgId=o1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers: { ...otherHandlers, '/api/v1/scan-staff': () => list.promise },
    });
    expect(await screen.findByText('Loading Staff')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add staff' })).not.toBeInTheDocument();
    await act(async () => list.resolve(json({ items: [sam, jo] })));
    const table = await screen.findByRole('table', { name: 'Staff' });
    const samRow = within(table).getByText('Sam K.').closest('tr');
    const joRow = within(table).getByText('Jo').closest('tr');
    expect(samRow).not.toBeNull();
    expect(joRow).not.toBeNull();
    expect(within(samRow as HTMLElement).getByText('Door')).toBeInTheDocument();
    expect(within(samRow as HTMLElement).getByText('Active')).toBeInTheDocument();
    expect(within(samRow as HTMLElement).getByText('Locked on a scanner')).toBeInTheDocument();
    expect(within(samRow as HTMLElement).getByText(/Front door/)).toBeInTheDocument();
    expect(within(joRow as HTMLElement).getByText('Manager')).toBeInTheDocument();
    expect(within(joRow as HTMLElement).getByText('Disabled')).toBeInTheDocument();
    expect(within(joRow as HTMLElement).getByText('Never')).toBeInTheDocument();
    expect(within(joRow as HTMLElement).queryByText(/Locked/)).not.toBeInTheDocument();
    expect(screen.getByText(/Staff and PINs are shared across live and test/)).toHaveTextContent(
      'Live mode',
    );
    expect(
      within(table).getByRole('columnheader', { name: 'Successful today' }),
    ).toBeInTheDocument();
    expect(
      within(samRow as HTMLElement).getByText(
        "12 successful, not-undone scans since each scanner's local midnight for Sam K.; removed scanners use UTC",
      ),
    ).toBeInTheDocument();
    expect(within(samRow as HTMLElement).queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText(/Successful today excludes undone scans/)).toHaveTextContent(
      "each scanner's local midnight",
    );
    expect(
      fetchMock.mock.calls.some(([url]) => String(url) === '/api/v1/scan-staff?orgId=o1&limit=50'),
    ).toBe(true);
    expect((await axe(container)).violations).toEqual([]);
  });

  it('shows an unavailable error and can retry rather than treating failure as an empty list', async () => {
    let available = false;
    await renderApp('/admin/scanning?tab=staff&orgId=o1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers: {
        ...otherHandlers,
        '/api/v1/scan-staff': () =>
          available ? json({ items: [] }) : problem(404, 'not_found', 'Not found.'),
      },
    });
    expect(
      await screen.findByText('Staff management is unavailable for this organization.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('No staff yet')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add staff' })).not.toBeInTheDocument();
    available = true;
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No staff yet')).toBeInTheDocument();
  });

  it('shows denied access rather than an empty staff list', async () => {
    await renderApp('/admin/scanning?tab=staff&orgId=o1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers: {
        ...otherHandlers,
        '/api/v1/scan-staff': () => problem(403, 'forbidden', 'Forbidden.'),
      },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('You do not have access.');
    expect(screen.queryByText('No staff yet')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add staff' })).not.toBeInTheDocument();
  });

  it('rejects a malformed staff list instead of inventing access or lock state', async () => {
    await renderApp('/admin/scanning?tab=staff&orgId=o1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers: {
        ...otherHandlers,
        '/api/v1/scan-staff': () => json({ items: [{ ...person(), locked: undefined }] }),
      },
    });
    expect(await screen.findByText('Could not load staff.')).toBeInTheDocument();
    expect(screen.queryByText('Sam K.')).not.toBeInTheDocument();
    expect(screen.queryByText('No staff yet')).not.toBeInTheDocument();
  });

  it('searches by name and shows more of a long list', async () => {
    const requests: URL[] = [];
    await renderApp('/admin/scanning?tab=staff&orgId=o1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers: {
        ...otherHandlers,
        '/api/v1/scan-staff': (url) => {
          requests.push(url);
          if (url.searchParams.get('cursor') === 'c1')
            return json({ items: [person({ id: 'staff-9', name: 'Zed' })] });
          return json({
            items: [person()],
            ...(url.searchParams.get('q') ? {} : { hasMore: true, nextCursor: 'c1' }),
          });
        },
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Show more staff' }));
    await vi.waitFor(() =>
      expect(requests.some((url) => url.searchParams.get('cursor') === 'c1')).toBe(true),
    );
    expect(await screen.findByText('Zed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show more staff' })).not.toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('Search staff'), 'sam');
    await vi.waitFor(() =>
      expect(requests.some((url) => url.searchParams.get('q') === 'sam')).toBe(true),
    );
    expect(screen.queryByRole('button', { name: 'Show more staff' })).not.toBeInTheDocument();
  });
});
