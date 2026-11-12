import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { MODE_HEADER } from '@/shared/contracts/common.ts';
import { resetModeForTests, setMode } from '../../lib/mode.ts';
import { membershipsQuery, sessionQuery } from '../../lib/session.ts';
import {
  type FetchHandler,
  json,
  membershipFixture,
  problem,
  renderApp,
  sessionFixture,
} from '../../lib/test-utils.tsx';
import { toast } from '../../ui/index.ts';
import { passKeys } from './api.ts';
import {
  connection,
  ORG,
  passDetail,
  passSummary,
  SAMPLE_PASS_JSON,
  templateDetail,
  templateSummary,
} from './test-fixtures.ts';

const orgScope = {
  memberships: [membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug })],
  selectedOrg: ORG.id,
};

/** The server answers for whoever is signed in, so a refetch after a switch agrees with the cache. */
function principalHandlers(current: () => string): Record<string, FetchHandler> {
  return {
    '/api/v1/session': () => {
      const session = sessionFixture('admin');
      if (!session.authenticated) throw new Error('Expected an authenticated fixture.');
      return json({ ...session, user: { ...session.user, id: current() } });
    },
    '/api/v1/orgs/memberships/me': () =>
      json({
        items: [
          membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug, userId: current() }),
        ],
      }),
  };
}

afterEach(resetModeForTests);
afterEach(() => vi.restoreAllMocks());

const method = (init?: RequestInit) => (init?.method ?? 'GET').toUpperCase();
const headersOf = (init?: RequestInit) => (init?.headers ?? {}) as Record<string, string>;

interface Server {
  pass: ReturnType<typeof passDetail>;
  calls: { method: string; path: string; init?: RequestInit }[];
}

function handlers(
  server: Server,
  extra: Record<string, FetchHandler> = {},
): Record<string, FetchHandler> {
  const log =
    (path: string, fn: FetchHandler): FetchHandler =>
    (url, init) => {
      server.calls.push({ method: method(init), path, init });
      return fn(url, init);
    };
  return {
    '/api/v1/orgs': () => json({ items: [ORG], nextCursor: null }),
    '/api/v1/templates': () => json({ items: [templateSummary()], nextCursor: null }),
    '/api/v1/templates/tpl1': () => json(templateDetail()),
    '/api/v1/passes': () => json({ items: [passSummary()], nextCursor: null }),
    '/api/v1/passes/p1': log('/passes/p1', () => json(server.pass)),
    '/api/v1/holders/p1': () =>
      json({
        passId: 'p1',
        state: server.pass.holderState,
        email: server.pass.holderEmail,
        ownerUserId: server.pass.ownerUserId,
        ownerName: server.pass.ownerName,
        blockedUserIds: [],
        transfer: null,
        reissueRequired: false,
        updatedAt: 1,
      }),
    '/api/v1/passes/p1/assets': () => json({ items: [] }),
    '/api/v1/delivery': () => json({ items: server.pass.deliveries }),
    '/api/v1/audit': () =>
      json({
        items: [
          {
            id: 1,
            at: 1,
            orgId: 'org1',
            actorType: 'user',
            actorId: 'u1',
            actorLabel: 'Ada Admin',
            action: 'pass.update',
            targetType: 'pass',
            targetId: 'p1',
            requestId: null,
            detail: null,
          },
        ],
        nextCursor: null,
      }),
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, log(k, v)])),
  };
}

function newServer(over: Record<string, unknown> = {}): Server {
  return { pass: passDetail(over), calls: [] };
}

function bundle(mode: 'live' | 'test' = 'live') {
  return {
    id: 'b1',
    orgId: ORG.id,
    mode,
    name: 'Private travel bundle',
    url: 'https://wallet.test/b/tok',
    holderEmail: null,
    passes: [{ id: 'p1', title: 'Private member', status: 'active' }],
    createdAt: 1,
    linkRotatedAt: null,
  };
}

function patchAware(server: Server, onPatch: (init?: RequestInit) => Response) {
  return handlers(server, {
    '/api/v1/passes/p1': (_u, init) =>
      method(init) === 'PATCH' ? onPatch(init) : json(server.pass),
  });
}

describe('pass detail: loading', () => {
  it('explains a pending transfer without rendering a stale pass', async () => {
    const server = newServer({ title: 'Private previous holder' });
    await renderApp('/admin/passes/p1', {
      session: 'admin',
      ...orgScope,
      handlers: handlers(server, {
        '/api/v1/passes/p1': () =>
          problem(
            409,
            'PASS_TRANSFER_PENDING',
            'This pass is being transferred while its existing wallet credentials are retired. Try again shortly.',
          ),
      }),
    });
    expect(await screen.findByText(/pass is being transferred/i)).toBeInTheDocument();
    expect(screen.queryByText('Private previous holder')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open public page' })).not.toBeInTheDocument();
  });

  it('hides a cached detail when a refresh discovers a pending transfer', async () => {
    const server = newServer({ title: 'Previously visible pass' });
    let pending = false;
    const { queryClient } = await renderApp('/admin/passes/p1', {
      session: 'admin',
      ...orgScope,
      handlers: handlers(server, {
        '/api/v1/passes/p1': () =>
          pending
            ? problem(
                409,
                'PASS_TRANSFER_PENDING',
                'This pass is being transferred. Try again shortly.',
              )
            : json(server.pass),
      }),
    });
    expect(
      await screen.findByRole('heading', { name: 'Previously visible pass' }),
    ).toBeInTheDocument();
    pending = true;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: passKeys.detail('p1') });
    });
    expect(await screen.findByText(/pass is being transferred/i)).toBeInTheDocument();
    expect(screen.queryByText('Previously visible pass')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open public page' })).not.toBeInTheDocument();
  });

  it.each([true, false])(
    'shows reissue guidance and offers replacement only to operators (%s)',
    async (canOperate) => {
      const server = newServer({ reissueRequired: true });
      const member = membershipFixture(ORG.id, {
        orgName: ORG.name,
        orgSlug: ORG.slug,
        capabilities: canOperate
          ? ['org:read', 'passes:read', 'passes:operate', 'templates:read']
          : ['org:read', 'passes:read', 'templates:read'],
      });
      await renderApp('/admin/passes/p1', {
        session: 'admin',
        memberships: [member],
        selectedOrg: ORG.id,
        handlers: handlers(server),
      });
      expect(await screen.findByText('Replacement required')).toBeInTheDocument();
      expect(screen.getByText(/verified holder has not been attached/i)).toBeInTheDocument();
      expect(Boolean(screen.queryByRole('link', { name: 'Create replacement' }))).toBe(canOperate);
    },
  );

  it('fetches the pass once when the detail mounts', async () => {
    const server = newServer();
    const { fetchMock } = await renderApp('/admin/passes/p1', {
      session: 'admin',
      ...orgScope,
      handlers: handlers(server),
    });
    await screen.findByLabelText(/Member name/);
    expect(server.calls.filter((c) => c.path === '/passes/p1' && c.method === 'GET')).toHaveLength(
      1,
    );
    const templateRequest = fetchMock.mock.calls
      .map(([input]) => new URL(String(input), 'http://localhost'))
      .find((url) => url.pathname === '/api/v1/templates/tpl1');
    expect(templateRequest?.searchParams.get('orgId')).toBe(ORG.id);
    // A visit, not a create: no buddy beside the pass.
    expect(document.querySelector('.wl-pass-buddy')).toBeNull();
  });

  it('renders a draft preview in the loaded pass organization and template revision', async () => {
    const user = userEvent.setup();
    const server = newServer({ orgId: 'org2' });
    const previews: Record<string, unknown>[] = [];
    await renderApp('/admin/passes/p1', {
      session: 'admin',
      memberships: [
        ...orgScope.memberships,
        membershipFixture('org2', { orgName: 'Second', orgSlug: 'second' }),
      ],
      selectedOrg: 'org2',
      handlers: handlers(server, {
        '/api/v1/templates/tpl1': () => json(templateDetail({ orgId: 'org2' })),
        '/api/v1/templates/tpl1/preview': (_url, init) => {
          previews.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return json({
            passJson: SAMPLE_PASS_JSON,
            warnings: [],
            assetBaseUrl: '/a',
            assetNames: [],
          });
        },
      }),
    });
    await user.type(await screen.findByLabelText(/Member name/), ' Jr');
    await waitFor(() =>
      expect(previews.at(-1)).toMatchObject({ orgId: 'org2', version: 'a1b2c3d4e5f6a7b8' }),
    );
  });

  it('canonicalizes a bare pass link to its authorized org instead of a stale remembered choice', async () => {
    localStorage.setItem('wallet-org-filter', ORG.id);
    try {
      const server = newServer({ orgId: 'org2', title: 'Second organization pass' });
      const { router } = await renderApp('/admin/passes/p1', {
        session: 'admin',
        memberships: [
          ...orgScope.memberships,
          membershipFixture('org2', { orgName: 'Second', orgSlug: 'second' }),
        ],
        handlers: handlers(server),
      });
      expect(
        await screen.findByRole('heading', { level: 1, name: 'Second organization pass' }),
      ).toBeInTheDocument();
      await waitFor(() => expect(router.state.location.search).toMatchObject({ orgId: 'org2' }));
      expect(localStorage.getItem('wallet-org-filter')).toBe('org2');
    } finally {
      localStorage.removeItem('wallet-org-filter');
    }
  });

  it.each(['moved', 'missing', 'forbidden'] as const)(
    'revalidates a cached pass before resolving a bare link when the fresh result is %s',
    async (outcome) => {
      const deferred = Promise as PromiseConstructor & {
        withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
      };
      const response = deferred.withResolvers<Response>();
      const server = newServer({ title: 'Cached pass title' });
      let requests = 0;
      try {
        const { router, fetchMock } = await renderApp('/admin/passes/p1', {
          session: 'admin',
          memberships: [
            ...orgScope.memberships,
            membershipFixture('org2', { orgName: 'Second', orgSlug: 'second' }),
          ],
          selectedOrg: ORG.id,
          handlers: handlers(server, {
            '/api/v1/passes/p1': () => {
              requests += 1;
              return requests === 1 ? json(server.pass) : response.promise;
            },
            '/api/v1/bundles': () => json({ items: [], nextCursor: null }),
          }),
        });
        expect(await screen.findByRole('heading', { name: 'Cached pass title' })).toBeVisible();
        await waitFor(() => expect(localStorage.getItem('wallet-org-filter')).toBe(ORG.id));
        await act(async () => {
          await router.navigate({
            to: '/admin/passes/$passId',
            params: { passId: 'p1' },
            search: { orgId: undefined, tab: 'delivery' },
          });
        });

        await waitFor(() => expect(requests).toBe(2));
        expect(screen.queryByText('Cached pass title')).toBeNull();
        expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
        expect(new URLSearchParams(router.state.location.searchStr).has('orgId')).toBe(false);
        expect(localStorage.getItem('wallet-org-filter')).toBe(ORG.id);
        expect(
          fetchMock.mock.calls.some(
            ([input]) => new URL(String(input), 'http://localhost').pathname === '/api/v1/bundles',
          ),
        ).toBe(false);

        await act(async () => {
          response.resolve(
            outcome === 'moved'
              ? json(passDetail({ orgId: 'org2', title: 'Moved pass title' }))
              : outcome === 'forbidden'
                ? problem(403, 'forbidden', 'Forbidden.')
                : problem(404, 'not_found', 'Pass not found.'),
          );
          await response.promise;
        });
        if (outcome === 'moved') {
          expect(await screen.findByRole('heading', { name: 'Moved pass title' })).toBeVisible();
          await waitFor(() =>
            expect(router.state.location.search).toMatchObject({ orgId: 'org2' }),
          );
          expect(localStorage.getItem('wallet-org-filter')).toBe('org2');
        } else {
          if (outcome === 'forbidden') {
            expect(
              await screen.findByRole('heading', { name: 'You do not have access' }),
            ).toBeVisible();
          } else {
            expect(await screen.findByText('Pass not found')).toBeVisible();
          }
          expect(new URLSearchParams(router.state.location.searchStr).has('orgId')).toBe(false);
          expect(localStorage.getItem('wallet-org-filter')).toBe(ORG.id);
          expect(screen.queryByText('Cached pass title')).toBeNull();
        }
      } finally {
        localStorage.removeItem('wallet-org-filter');
      }
    },
  );

  it('does not canonicalize a bare link to an organization without membership, even for an admin', async () => {
    localStorage.setItem('wallet-org-filter', ORG.id);
    try {
      const server = newServer({ orgId: 'org2', title: 'Private other organization pass' });
      const { fetchMock } = await renderApp('/admin/passes/p1?tab=delivery', {
        session: 'admin',
        memberships: orgScope.memberships,
        handlers: handlers(server),
      });
      expect(await screen.findByText('Pass not found')).toBeInTheDocument();
      expect(screen.queryByText('Private other organization pass')).toBeNull();
      expect(
        fetchMock.mock.calls.some(
          ([input]) => new URL(String(input), 'http://localhost').pathname === '/api/v1/bundles',
        ),
      ).toBe(false);
    } finally {
      localStorage.removeItem('wallet-org-filter');
    }
  });

  it('shows a non-disclosing not-found state for a pass in another selected organization', async () => {
    const server = newServer({
      orgId: 'org2',
      title: 'Private member',
      serial: 'SECRET-001',
      holderEmail: 'private@example.test',
    });
    const { fetchMock } = await renderApp('/admin/passes/p1?tab=delivery&v=2', {
      session: 'admin',
      memberships: [
        ...orgScope.memberships,
        membershipFixture('org2', { orgName: 'Second', orgSlug: 'second' }),
      ],
      selectedOrg: ORG.id,
      handlers: handlers(server, {
        '/api/v1/bundles': () => json({ items: [bundle()], nextCursor: null }),
      }),
    });

    expect(await screen.findByText('Pass not found')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Pass' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to passes' })).toHaveAttribute(
      'href',
      '/admin/passes?orgId=org1',
    );
    expect(screen.queryByText('Private member')).toBeNull();
    expect(screen.queryByText('SECRET-001')).toBeNull();
    expect(screen.queryByText('private@example.test')).toBeNull();
    expect(screen.queryByText('Private travel bundle')).toBeNull();
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
    expect(screen.queryByRole('tablist', { name: 'Pass sections' })).toBeNull();

    const paths = fetchMock.mock.calls.map(
      ([input]) => new URL(String(input), 'http://localhost').pathname,
    );
    expect(paths).toContain('/api/v1/passes/p1');
    for (const path of [
      '/api/v1/templates/tpl1',
      '/api/v1/passes/p1/versions/2',
      '/api/v1/passes/p1/assets',
      '/api/v1/delivery',
      '/api/v1/bundles',
    ]) {
      expect(paths).not.toContain(path);
    }
  });

  it('unmounts pass and bundle data when the selected organization changes', async () => {
    const user = userEvent.setup();
    const server = newServer({ title: 'Private member', serial: 'SECRET-001' });
    await renderApp('/admin/passes/p1?tab=delivery', {
      session: 'admin',
      memberships: [
        ...orgScope.memberships,
        membershipFixture('org2', { orgName: 'Second', orgSlug: 'second' }),
      ],
      selectedOrg: ORG.id,
      handlers: handlers(server, {
        '/api/v1/bundles': () => json({ items: [bundle()], nextCursor: null }),
      }),
    });
    expect(await screen.findByText('Private travel bundle')).toBeInTheDocument();
    expect(server.calls.filter((c) => c.path === '/api/v1/bundles')).toHaveLength(1);

    await user.click(screen.getByRole('combobox', { name: /^Organization filter/ }));
    await user.click(await screen.findByRole('option', { name: 'Second' }));
    expect(await screen.findByText('Pass not found')).toBeInTheDocument();
    expect(screen.queryByText('Private member')).toBeNull();
    expect(screen.queryByText('SECRET-001')).toBeNull();
    expect(screen.queryByText('Private travel bundle')).toBeNull();
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
    expect(server.calls.filter((c) => c.path === '/api/v1/bundles')).toHaveLength(1);
  });

  it.each([
    { passMode: 'live', selectedMode: 'test' },
    { passMode: 'test', selectedMode: 'live' },
  ] as const)(
    'requests bundles in the pass mode $passMode rather than selected mode $selectedMode',
    async ({ passMode, selectedMode }) => {
      setMode(selectedMode);
      const server = newServer({ mode: passMode });
      const requests: { url: URL; init?: RequestInit }[] = [];
      await renderApp('/admin/passes/p1?tab=delivery', {
        session: 'admin',
        ...orgScope,
        handlers: handlers(server, {
          '/api/v1/bundles': (url, init) => {
            requests.push({ url, init });
            return json({ items: [bundle(passMode)], nextCursor: null });
          },
        }),
      });

      expect(await screen.findByText('Private travel bundle')).toBeInTheDocument();
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url.searchParams.get('orgId')).toBe(ORG.id);
      expect(requests[0]?.url.searchParams.get('passId')).toBe('p1');
      expect(requests[0]?.url.searchParams.get('limit')).toBe('50');
      expect(headersOf(requests[0]?.init)[MODE_HEADER]).toBe(passMode);
    },
  );
});

describe('pass detail: save and conflicts', () => {
  it('saves only the changed keys with the loaded version in If-Match', async () => {
    const user = userEvent.setup();
    const server = newServer();
    await renderApp('/admin/passes/p1', {
      session: 'admin',
      ...orgScope,
      handlers: patchAware(server, () => {
        server.pass = passDetail({
          version: 4,
          personalization: { name: 'Sam Jones Jr', level: 'copper' },
        });
        return json(server.pass);
      }),
    });
    await user.type(await screen.findByLabelText(/Member name/), ' Jr');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument());
    const patch = server.calls.find((c) => c.method === 'PATCH');
    expect(headersOf(patch?.init)['if-match']).toBe('3');
    expect(JSON.parse(String(patch?.init?.body))).toEqual({ input: { name: 'Sam Jones Jr' } });
    expect(screen.getByLabelText(/Member name/)).toHaveValue('Sam Jones Jr');
  });

  it.each([
    ['saved', 'principal'],
    ['conflict', 'principal'],
    ['saved', 'capability'],
    ['conflict', 'capability'],
  ] as const)('does not publish a field %s result after %s changes', async (outcome, change) => {
    const deferred = Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
    };
    const response = deferred.withResolvers<Response>();
    const user = userEvent.setup();
    const server = newServer();
    const { queryClient } = await renderApp('/admin/passes/p1', {
      session: 'admin',
      ...orgScope,
      handlers: handlers(server, {
        '/api/v1/passes/p1': (_url, init) =>
          method(init) === 'PATCH' ? response.promise : json(server.pass),
      }),
    });
    await user.type(await screen.findByLabelText(/Member name/), ' Jr');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(server.calls.some((call) => call.method === 'PATCH')).toBe(true));

    act(() => {
      if (change === 'principal') {
        const next = sessionFixture('admin');
        if (!next.authenticated) throw new Error('Expected an authenticated fixture.');
        const updatedSession: typeof next = { ...next, user: { ...next.user, id: 'u2' } };
        queryClient.setQueryData(sessionQuery.queryKey, updatedSession);
        queryClient.setQueryData(membershipsQuery.queryKey, {
          items: [
            membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug, userId: 'u2' }),
          ],
        });
      } else {
        queryClient.setQueryData(membershipsQuery.queryKey, {
          items: [
            membershipFixture(ORG.id, {
              orgName: ORG.name,
              orgSlug: ORG.slug,
              capabilities: ['org:read', 'passes:read', 'templates:read'],
            }),
          ],
        });
      }
    });
    const setData = vi.spyOn(queryClient, 'setQueryData');
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const success = vi.spyOn(toast, 'success');
    const error = vi.spyOn(toast, 'error');
    await act(async () => {
      response.resolve(
        outcome === 'saved'
          ? json(passDetail({ version: 4, title: 'Former principal result' }))
          : problem(412, 'VERSION_CONFLICT', 'Changed'),
      );
      await response.promise;
    });
    expect(setData).not.toHaveBeenCalledWith(
      passKeys.detail('p1'),
      expect.objectContaining({ title: 'Former principal result' }),
    );
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: passKeys.all });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: passKeys.detail('p1') });
    expect(success).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('keeps the draft on 412 and offers merge, then saves against the new version', async () => {
    const user = userEvent.setup();
    const server = newServer();
    let patches = 0;
    await renderApp('/admin/passes/p1', {
      session: 'admin',
      ...orgScope,
      handlers: patchAware(server, () => {
        patches += 1;
        if (patches === 1) {
          // Someone else saved first.
          server.pass = passDetail({
            version: 4,
            personalization: { name: 'Sam Jones', level: 'blue' },
          });
          return problem(412, 'VERSION_CONFLICT', 'The resource changed. Reload and retry.');
        }
        server.pass = passDetail({
          version: 5,
          personalization: { name: 'Sam Jones Jr', level: 'blue' },
        });
        return json(server.pass);
      }),
    });
    const input = await screen.findByLabelText(/Member name/);
    await user.type(input, ' Jr');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const banner = await screen.findByText(/This pass changed since you opened it/);
    expect(banner).toBeInTheDocument();
    // The draft survives.
    expect(screen.getByLabelText(/Member name/)).toHaveValue('Sam Jones Jr');
    const merge = screen.getByRole('button', { name: 'Merge my edits' });
    await waitFor(() => expect(merge).toBeEnabled());
    await user.click(merge);
    expect(screen.getByLabelText(/Member name/)).toHaveValue('Sam Jones Jr');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches).toBe(2));
    const sent = server.calls.filter((c) => c.method === 'PATCH');
    expect(headersOf(sent[1]?.init)['if-match']).toBe('4');
    // Only my change is sent; the other admin's level is not overwritten.
    expect(JSON.parse(String(sent[1]?.init?.body))).toEqual({ input: { name: 'Sam Jones Jr' } });
    await waitFor(() => expect(screen.queryByText(/This pass changed/)).not.toBeInTheDocument());
  });

  it('reloads the server values and drops the draft on request', async () => {
    const user = userEvent.setup();
    const server = newServer();
    await renderApp('/admin/passes/p1', {
      session: 'admin',
      ...orgScope,
      handlers: patchAware(server, () => {
        server.pass = passDetail({
          version: 4,
          personalization: { name: 'Server Name', level: 'copper' },
        });
        return problem(412, 'VERSION_CONFLICT', 'Changed.');
      }),
    });
    await user.type(await screen.findByLabelText(/Member name/), ' Jr');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const reload = await screen.findByRole('button', { name: 'Reload' });
    await waitFor(() => expect(reload).toBeEnabled());
    await user.click(reload);
    expect(screen.getByLabelText(/Member name/)).toHaveValue('Server Name');
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
  });

  it('adopts a newer server version silently while the form is clean', async () => {
    const server = newServer();
    const { queryClient } = await renderApp('/admin/passes/p1', {
      session: 'admin',
      ...orgScope,
      handlers: handlers(server),
    });
    expect(await screen.findByLabelText(/Member name/)).toHaveValue('Sam Jones');
    server.pass = passDetail({ version: 4, personalization: { name: 'Changed', level: 'copper' } });
    await queryClient.invalidateQueries({ queryKey: ['admin', 'passes'] });
    await waitFor(() => expect(screen.getByLabelText(/Member name/)).toHaveValue('Changed'));
    expect(screen.queryByText(/This pass changed/)).not.toBeInTheDocument();
  });

  it('shows server field errors from a 422 and keeps the draft', async () => {
    const user = userEvent.setup();
    const server = newServer();
    await renderApp('/admin/passes/p1', {
      session: 'admin',
      ...orgScope,
      handlers: patchAware(server, () =>
        problem(422, 'VALIDATION', 'Invalid.', [{ path: 'input.name', message: 'Name is taken.' }]),
      ),
    });
    await user.type(await screen.findByLabelText(/Member name/), 'x');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Name is taken.')).toBeInTheDocument();
    expect(screen.getByLabelText(/Member name/)).toHaveValue('Sam Jonesx');
  });

  it('resets a manual field to the connection', async () => {
    const user = userEvent.setup();
    const server = newServer({ connectionId: 'c1' });
    await renderApp('/admin/passes/p1', {
      session: 'admin',
      ...orgScope,
      handlers: patchAware(server, (init) => {
        server.pass = passDetail({
          connectionId: 'c1',
          version: 4,
          fieldSources: { name: 'connection', level: 'manual' },
        });
        expect(JSON.parse(String(init?.body))).toEqual({ resetToConnection: ['name'] });
        return json(server.pass);
      }),
    });
    await user.click(
      await screen.findByRole('button', { name: "Use the connection's value for Member name" }),
    );
    // The connection owns the field again: it locks with a From chip.
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: /Member name/ })).toBeDisabled(),
    );
  });

  it('has no axe violations', async () => {
    const { container } = await renderApp('/admin/passes/p1', {
      session: 'admin',
      ...orgScope,
      handlers: handlers(newServer()),
    });
    await screen.findByLabelText(/Member name/);
    expect((await axe(container)).violations).toEqual([]);
  });
});

describe('pass detail: tabs', () => {
  it('assigns a waiting holder', async () => {
    const user = userEvent.setup();
    const server = newServer();
    await renderApp('/admin/passes/p1?tab=holder', {
      session: 'admin',
      ...orgScope,
      handlers: handlers(server, {
        '/api/v1/holders/assign': (_u, init) => {
          expect(JSON.parse(String(init?.body))).toEqual({
            passId: 'p1',
            email: 'new@example.com',
          });
          return json({
            passId: 'p1',
            state: 'waiting',
            email: 'new@example.com',
            ownerUserId: null,
            ownerName: null,
            blockedUserIds: [],
            transfer: { transferId: 'transfer1', state: 'completed' },
            reissueRequired: false,
            updatedAt: 1,
          });
        },
      }),
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Change' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Change' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change holder' });
    const email = within(dialog).getByLabelText('Email');
    await user.clear(email);
    await user.type(email, 'new@example.com');
    // Sending is on by default and names the address.
    expect(
      within(dialog).getByRole('checkbox', { name: 'Email the pass to new@example.com' }),
    ).toBeChecked();
    await user.click(within(dialog).getByRole('checkbox', { name: /Email the pass/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Change holder' }));
    await waitFor(() =>
      expect(server.calls.some((c) => c.path === '/api/v1/holders/assign')).toBe(true),
    );
    expect(server.calls.some((c) => c.path === '/api/v1/passes/p1/resend-email')).toBe(false);
  });

  it('does not send a pass or report success while the holder transfer is pending', async () => {
    const user = userEvent.setup();
    const server = newServer();
    let transferring = false;
    const response = () => ({
      passId: 'p1',
      state: server.pass.holderState,
      email: server.pass.holderEmail,
      ownerUserId: server.pass.ownerUserId,
      ownerName: server.pass.ownerName,
      blockedUserIds: [],
      updatedAt: 1,
      transfer: transferring ? { transferId: 'transfer-pending', state: 'pending' } : null,
      reissueRequired: false,
    });
    await renderApp('/admin/passes/p1?tab=holder', {
      session: 'admin',
      ...orgScope,
      handlers: handlers(server, {
        '/api/v1/holders/p1': () => json(response()),
        '/api/v1/holders/assign': () => {
          transferring = true;
          return json(response());
        },
        '/api/v1/passes/p1/resend-email': () => json({ ok: true }, 202),
      }),
    });
    const change = await screen.findByRole('button', { name: 'Change' });
    await waitFor(() => expect(change).toBeEnabled());
    await user.click(change);
    const dialog = await screen.findByRole('dialog', { name: 'Change holder' });
    const email = within(dialog).getByLabelText('Email');
    await user.clear(email);
    await user.type(email, 'new@example.com');
    await user.click(within(dialog).getByRole('button', { name: 'Change and send' }));
    expect(
      await screen.findByText(/Existing wallet credentials are being retired/),
    ).toBeInTheDocument();
    expect(server.calls.some((c) => c.path === '/api/v1/passes/p1/resend-email')).toBe(false);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Change' })).toBeDisabled());
  });

  it('shows the issuer that verified attachment requires a reissue', async () => {
    const server = newServer();
    await renderApp('/admin/passes/p1?tab=holder', {
      session: 'admin',
      ...orgScope,
      handlers: handlers(server, {
        '/api/v1/holders/p1': () =>
          json({
            passId: 'p1',
            state: server.pass.holderState,
            email: server.pass.holderEmail,
            ownerUserId: server.pass.ownerUserId,
            ownerName: server.pass.ownerName,
            blockedUserIds: [],
            transfer: null,
            reissueRequired: true,
            updatedAt: 1,
          }),
      }),
    });
    expect(
      await screen.findByText(/Automatic holder attachment needs this pass to be reissued/),
    ).toBeInTheDocument();
  });

  it('reports an uncertain email separately after changing the holder', async () => {
    const user = userEvent.setup();
    const server = newServer();
    await renderApp('/admin/passes/p1?tab=holder', {
      session: 'admin',
      ...orgScope,
      handlers: handlers(server, {
        '/api/v1/holders/assign': () =>
          json({
            passId: 'p1',
            state: 'waiting',
            email: 'new@example.com',
            ownerUserId: null,
            ownerName: null,
            blockedUserIds: [],
            transfer: { transferId: 'transfer1', state: 'completed' },
            reissueRequired: false,
            updatedAt: 1,
          }),
        '/api/v1/passes/p1/resend-email': () => problem(500, 'ERROR', 'Email request failed'),
      }),
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Change' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Change' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change holder' });
    const email = within(dialog).getByLabelText('Email');
    await user.clear(email);
    await user.type(email, 'new@example.com');
    await user.click(within(dialog).getByRole('button', { name: 'Change and send' }));
    expect(await screen.findByText(/Holder changed. Email status unknown/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Change holder' })).toBeNull());
    expect(server.calls.filter((c) => c.path === '/api/v1/holders/assign')).toHaveLength(1);
    expect(server.calls.filter((c) => c.path === '/api/v1/passes/p1/resend-email')).toHaveLength(1);
  });

  it('does not send holder mail after the initiating principal changes', async () => {
    const deferred = Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
    };
    const response = deferred.withResolvers<Response>();
    const user = userEvent.setup();
    const server = newServer();
    const { queryClient } = await renderApp('/admin/passes/p1?tab=holder', {
      session: 'admin',
      ...orgScope,
      handlers: handlers(server, {
        '/api/v1/holders/assign': () => response.promise,
        '/api/v1/passes/p1/resend-email': () => json({ ok: true }, 202),
      }),
    });
    const info = vi.spyOn(toast, 'info');
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Change' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Change' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change holder' });
    const email = within(dialog).getByLabelText('Email');
    await user.clear(email);
    await user.type(email, 'new@example.com');
    await user.click(within(dialog).getByRole('button', { name: 'Change and send' }));
    await waitFor(() =>
      expect(server.calls.some((call) => call.path === '/api/v1/holders/assign')).toBe(true),
    );

    const next = sessionFixture('admin');
    if (!next.authenticated) throw new Error('Expected an authenticated fixture.');
    act(() => {
      const updatedSession: typeof next = { ...next, user: { ...next.user, id: 'u2' } };
      queryClient.setQueryData(sessionQuery.queryKey, updatedSession);
      queryClient.setQueryData(membershipsQuery.queryKey, {
        items: [membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug, userId: 'u2' })],
      });
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Change holder' })).toBeNull());
    await act(async () => {
      response.resolve(
        json({
          passId: 'p1',
          state: 'waiting',
          email: 'new@example.com',
          ownerUserId: null,
          ownerName: null,
          blockedUserIds: [],
          transfer: { transferId: 'transfer1', state: 'completed' },
          reissueRequired: false,
          updatedAt: 1,
        }),
      );
      await response.promise;
    });
    await waitFor(() => expect(queryClient.isMutating()).toBe(0));
    expect(server.calls.some((call) => call.path === '/api/v1/passes/p1/resend-email')).toBe(false);
    expect(info).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('confirms before reassigning an owned pass', async () => {
    const user = userEvent.setup();
    const server = newServer({
      holderState: 'owned',
      ownerUserId: 'u9',
      ownerName: 'Olive Owner',
      holderEmail: 'a@example.com',
    });
    await renderApp('/admin/passes/p1?tab=holder', {
      session: 'admin',
      ...orgScope,
      handlers: handlers(server, {
        '/api/v1/passes/p1/resend-email': () => json({ ok: true }, 202),
        '/api/v1/holders/reassign': () =>
          json({
            passId: 'p1',
            state: 'waiting',
            email: 'b@example.com',
            ownerUserId: null,
            ownerName: null,
            blockedUserIds: [],
            transfer: { transferId: 'transfer1', state: 'completed' },
            reissueRequired: false,
            updatedAt: 1,
          }),
      }),
    });
    expect(await screen.findByRole('link', { name: /Olive Owner/ })).toHaveAttribute(
      'href',
      '/admin/users/u9',
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Change' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Change' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change holder' });
    expect(dialog).toHaveTextContent('The current owner loses access');
    const email = within(dialog).getByLabelText('Email');
    await user.clear(email);
    await user.type(email, 'b@example.com');
    expect(server.calls.some((c) => c.path === '/api/v1/holders/reassign')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Change and send' }));
    await waitFor(() =>
      expect(server.calls.some((c) => c.path === '/api/v1/holders/reassign')).toBe(true),
    );
    // One email to the new holder.
    await waitFor(() =>
      expect(server.calls.filter((c) => c.path === '/api/v1/passes/p1/resend-email')).toHaveLength(
        1,
      ),
    );
  });

  it('rejects a non-PNG image before upload and shows server image errors', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const server = newServer();
    await renderApp('/admin/passes/p1?tab=images', {
      session: 'admin',
      ...orgScope,
      handlers: handlers(server, {
        '/api/v1/passes/p1/assets/icon@2x.png': () =>
          problem(422, 'ASSET_DIMENSIONS', 'icon@2x.png must be 76 × 76 px.'),
      }),
    });
    await screen.findByRole('button', { name: 'Replace Icon' });
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    await user.upload(input, new File(['nope'], 'bad.png', { type: 'image/png' }));
    expect(await screen.findByText('Not a PNG file.')).toBeInTheDocument();
    expect(server.calls.some((c) => c.method === 'PUT')).toBe(false);

    const png = (w: number, h: number) => {
      const bytes = new Uint8Array(33);
      bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      new DataView(bytes.buffer).setUint32(16, w);
      new DataView(bytes.buffer).setUint32(20, h);
      return new File([bytes], 'ok.png', { type: 'image/png' });
    };
    // A size that fits no scale is refused here, naming what fits.
    await user.upload(input, png(500, 40));
    expect(
      await screen.findByText(/does not fit icon\. Use 76 × 76 px \(@2x\)/),
    ).toBeInTheDocument();
    expect(server.calls.some((c) => c.method === 'PUT')).toBe(false);
    // The scale comes from the size; the server's message shows on the tile.
    await user.upload(input, png(76, 76));
    expect(await screen.findByText('icon@2x.png must be 76 × 76 px.')).toBeInTheDocument();
    expect(server.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });

  it('creates a new email to the current holder rather than claiming to retry the original recipient', async () => {
    const user = userEvent.setup();
    const server = newServer();
    await renderApp('/admin/passes/p1?tab=delivery', {
      session: 'admin',
      ...orgScope,
      handlers: handlers(server, {
        '/api/v1/passes/p1/resend-email': () => json({ ok: true }, 202),
      }),
    });
    expect(await screen.findByText(/original recipient is not recorded here/)).toBeInTheDocument();
    const b = screen.getByRole('button', { name: 'Send to current holder' });
    await user.click(b);
    await waitFor(() => {
      const call = server.calls.find((c) => c.path === '/api/v1/passes/p1/resend-email');
      expect(headersOf(call?.init)['idempotency-key']).toBeTruthy();
    });
  });

  it.each([
    ['form', 'success'],
    ['form', 'failure'],
    ['email retry', 'success'],
    ['email retry', 'failure'],
    ['push retry', 'success'],
    ['push retry', 'failure'],
  ] as const)(
    'does not publish %s completion for a different principal on %s',
    async (kind, outcome) => {
      const deferred = Promise as PromiseConstructor & {
        withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
      };
      const response = deferred.withResolvers<Response>();
      let principal = 'u1';
      const user = userEvent.setup();
      const server = newServer(
        kind === 'push retry'
          ? {
              deliveries: [
                {
                  id: 'push:p1:3',
                  kind: 'push',
                  state: 'failed',
                  attempts: 1,
                  errorCode: 'PUSH_FAILED',
                  createdAt: 1,
                  finishedAt: 2,
                },
              ],
            }
          : {},
      );
      const { queryClient, fetchMock } = await renderApp('/admin/passes/p1?tab=delivery', {
        session: 'admin',
        ...orgScope,
        handlers: handlers(server, {
          ...principalHandlers(() => principal),
          '/api/v1/passes/p1/resend-email': () => response.promise,
          '/api/v1/passes/p1/refresh': () => response.promise,
        }),
      });
      const info = vi.spyOn(toast, 'info');
      const error = vi.spyOn(toast, 'error');
      const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
      const name =
        kind === 'form'
          ? 'Resend email'
          : kind === 'email retry'
            ? 'Send to current holder'
            : 'Request update';
      const previous = await screen.findByRole('button', { name });
      await user.click(previous);
      const path =
        kind === 'push retry' ? '/api/v1/passes/p1/refresh' : '/api/v1/passes/p1/resend-email';
      await waitFor(() => expect(server.calls.some((call) => call.path === path)).toBe(true));

      const next = sessionFixture('admin');
      if (!next.authenticated) throw new Error('Expected an authenticated fixture.');
      principal = 'u2';
      act(() => {
        const updatedSession: typeof next = { ...next, user: { ...next.user, id: 'u2' } };
        queryClient.setQueryData(sessionQuery.queryKey, updatedSession);
        queryClient.setQueryData(membershipsQuery.queryKey, {
          items: [
            membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug, userId: 'u2' }),
          ],
        });
      });
      await waitFor(() => expect(screen.getByRole('button', { name })).not.toBe(previous));
      await waitFor(() =>
        expect(
          queryClient.getQueryState(['admin', 'passes', 'delivery', ORG.id, 'p1'])?.fetchStatus,
        ).toBe('idle'),
      );
      const readsBefore = fetchMock.mock.calls.filter(
        ([input]) => new URL(String(input), 'http://localhost').pathname === '/api/v1/delivery',
      ).length;
      await act(async () => {
        response.resolve(
          outcome === 'failure'
            ? problem(500, 'failure', 'Request failed.')
            : kind === 'push retry'
              ? json({ accepted: true, requestedAt: 1 })
              : json({ ok: true }, 202),
        );
        await response.promise;
      });
      await waitFor(() => expect(queryClient.isMutating()).toBe(0));
      expect(info).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(invalidate).not.toHaveBeenCalled();
      expect(
        fetchMock.mock.calls.filter(
          ([input]) => new URL(String(input), 'http://localhost').pathname === '/api/v1/delivery',
        ),
      ).toHaveLength(readsBefore);
    },
  );

  it.each(['success', 'failure'] as const)(
    'does not publish a bundle email result to a different principal on %s',
    async (outcome) => {
      const deferred = Promise as PromiseConstructor & {
        withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
      };
      const response = deferred.withResolvers<Response>();
      let principal = 'u1';
      const user = userEvent.setup();
      const server = newServer();
      const { queryClient } = await renderApp('/admin/passes/p1?tab=delivery', {
        session: 'admin',
        ...orgScope,
        handlers: handlers(server, {
          ...principalHandlers(() => principal),
          '/api/v1/bundles': () =>
            json({
              items: [{ ...bundle(), holderEmail: 'sam@example.com' }],
              nextCursor: null,
            }),
          '/api/v1/bundles/b1/send-email': () => response.promise,
        }),
      });
      const info = vi.spyOn(toast, 'info');
      const error = vi.spyOn(toast, 'error');
      const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
      const previous = await screen.findByRole('button', {
        name: 'Actions for Private travel bundle',
      });
      await user.click(previous);
      await user.click(await screen.findByRole('menuitem', { name: 'Send email' }));
      await waitFor(() =>
        expect(server.calls.some((call) => call.path === '/api/v1/bundles/b1/send-email')).toBe(
          true,
        ),
      );

      const next = sessionFixture('admin');
      if (!next.authenticated) throw new Error('Expected an authenticated fixture.');
      principal = 'u2';
      act(() => {
        const updatedSession: typeof next = { ...next, user: { ...next.user, id: 'u2' } };
        queryClient.setQueryData(sessionQuery.queryKey, updatedSession);
        queryClient.setQueryData(membershipsQuery.queryKey, {
          items: [
            membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug, userId: 'u2' }),
          ],
        });
      });
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Actions for Private travel bundle' })).not.toBe(
          previous,
        ),
      );
      await act(async () => {
        response.resolve(
          outcome === 'success'
            ? json({ ok: true }, 202)
            : problem(500, 'failure', 'Bundle email failed.'),
        );
        await response.promise;
      });
      await waitFor(() => expect(queryClient.isMutating()).toBe(0));
      expect(info).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(invalidate).not.toHaveBeenCalled();
    },
  );

  it('shows persisted pass context and distinguishes requests from installation', async () => {
    await renderApp('/admin/passes/p1', {
      session: 'admin',
      ...orgScope,
      handlers: handlers(newServer()),
    });
    expect((await screen.findAllByText('SER-001')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('a1b2c3d4e5f6a7b8').length).toBeGreaterThan(0);
    expect(screen.queryByText(/does not prove that a device fetched the pass/)).toBeNull();
  });

  it('does not offer a holder resend when no holder is assigned', async () => {
    await renderApp('/admin/passes/p1?tab=delivery', {
      session: 'admin',
      ...orgScope,
      handlers: handlers(newServer({ holderEmail: null, holderState: 'unassigned' })),
    });
    expect(await screen.findByRole('button', { name: 'Send to current holder' })).toBeDisabled();
  });

  it('explains voiding without inventing a void timestamp', async () => {
    await renderApp('/admin/passes/p1', {
      session: 'admin',
      ...orgScope,
      handlers: handlers(newServer({ status: 'voided', voided: null })),
    });
    expect(await screen.findByText(/This pass is voided/)).toHaveTextContent(
      'Voiding is separate from removal from Wallet.',
    );
    expect(screen.getByRole('button', { name: 'Unvoid' })).toBeInTheDocument();
  });

  it('preserves field ownership when binding without takeover and guards dismissal', async () => {
    const user = userEvent.setup();
    const server = newServer();
    await renderApp('/admin/passes/p1?tab=connection', {
      session: 'admin',
      ...orgScope,
      handlers: handlers(server, {
        '/api/v1/connections': () => json({ items: [connection()], nextCursor: null }),
        '/api/v1/passes/p1/connection': () => json(server.pass),
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Bind to a connection' }));
    const dialog = await screen.findByRole('dialog', { name: 'Bind to a connection' });
    await user.click(within(dialog).getByRole('combobox', { name: /Connection/ }));
    await user.click(await screen.findByRole('option', { name: 'MemberSpot sync' }));
    await user.type(within(dialog).getByLabelText(/Record id/), 'm-042');
    await user.keyboard('{Escape}');
    const discard = await screen.findByRole('alertdialog');
    await user.click(within(discard).getByRole('button', { name: /keep editing/i }));
    await user.click(within(dialog).getByRole('button', { name: 'Bind' }));
    await waitFor(() => {
      const call = server.calls.find((c) => c.path === '/api/v1/passes/p1/connection');
      expect(JSON.parse(String(call?.init?.body))).toEqual({
        connectionId: 'c1',
        externalRef: 'm-042',
        resetFieldSources: false,
      });
    });
  });

  it('renders a retained version and diffs two versions', async () => {
    const user = userEvent.setup();
    const server = newServer();
    await renderApp('/admin/passes/p1?tab=versions', {
      session: 'admin',
      ...orgScope,
      handlers: handlers(server, {
        '/api/v1/passes/p1/versions/2': () =>
          json(passDetail({ version: 2, passJson: { ...SAMPLE_PASS_JSON, description: 'Old' } })),
        '/api/v1/passes/p1/diff': () =>
          json({ changes: [{ path: 'description', from: 'Old', to: 'Membership' }] }),
      }),
    });
    expect(await screen.findByText('description')).toBeInTheDocument();
    const changes = screen.getByRole('list', { name: 'Changes' });
    expect(within(changes).getByText('Old')).toBeInTheDocument();
    expect(within(changes).getByText('Membership')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview v1' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /^Render/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Preview v2' }));
    await waitFor(() =>
      expect(server.calls.some((c) => c.path === '/api/v1/passes/p1/versions/2')).toBe(true),
    );
  });

  it('lists activity from the audit log', async () => {
    const { fetchMock } = await renderApp('/admin/passes/p1?tab=activity', {
      session: 'admin',
      ...orgScope,
      handlers: handlers(newServer()),
    });
    expect(await screen.findByText('Pass updated')).toBeInTheDocument();
    expect(screen.getByText('Ada Admin')).toBeInTheDocument();
    expect(screen.queryByText(/u1/)).toBeNull();
    const request = fetchMock.mock.calls
      .map(([input]) => new URL(String(input), 'http://localhost'))
      .find((url) => url.pathname === '/api/v1/audit');
    expect(request?.searchParams.get('orgId')).toBe(ORG.id);
    expect(request?.searchParams.get('targetType')).toBe('pass');
    expect(request?.searchParams.get('targetId')).toBe('p1');
    expect(request?.searchParams.get('limit')).toBe('50');
  });

  it('names the owner and the pass instead of showing ids', async () => {
    await renderApp('/admin/passes/p1?tab=holder', {
      session: 'admin',
      ...orgScope,
      handlers: handlers(
        newServer({
          holderState: 'owned',
          ownerUserId: 'u9',
          ownerName: 'Olive Owner',
          ownerEmail: 'olive@example.com',
        }),
      ),
    });
    const link = await screen.findByRole('link', { name: /Olive Owner/ });
    expect(link).toHaveAttribute('href', '/admin/users/u9');
    expect(link).toHaveTextContent('olive@example.com');
    expect(screen.queryByText('u9')).toBeNull();
    const crumb = screen.getByRole('navigation', { name: /breadcrumb/i });
    expect(crumb).toHaveTextContent('Passes');
    expect(crumb).not.toHaveTextContent('p1');
  });

  it('counts devices in the header; the list lives in the Devices tab', async () => {
    await renderApp('/admin/passes/p1?tab=delivery', {
      session: 'admin',
      ...orgScope,
      handlers: handlers(newServer()),
    });
    expect(await screen.findByText('On 2 devices')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Devices' })).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Devices' })).toBeNull();
  });

  it('says why each push went, and that a push with no device reached nothing', async () => {
    const push = { kind: 'push' as const, attempts: 1, createdAt: 4, finishedAt: 4 };
    const server = newServer({
      deliveries: [
        { ...push, id: 'push:p1:3', state: 'cancelled', errorCode: 'NO_DEVICES' },
        { ...push, id: 'push:p1:refresh:x9', state: 'sent', errorCode: null },
      ],
    });
    await renderApp('/admin/passes/p1?tab=delivery', {
      session: 'admin',
      ...orgScope,
      handlers: handlers(server),
    });
    const table = await screen.findByRole('table', { name: 'Delivery history' });
    const [, first, second] = within(table).getAllByRole('row');
    expect(first).toHaveTextContent('Version 3');
    expect(first).toHaveTextContent('No devices');
    expect(first).not.toHaveTextContent('NO_DEVICES');
    expect(first).not.toHaveTextContent('Sent');
    expect(second).toHaveTextContent('Refresh');
    expect(second).toHaveTextContent('Sent');
  });

  it('titles the email card by whether it was sent, prefilled with the holder', async () => {
    const never = newServer({ deliveries: [] });
    await renderApp('/admin/passes/p1?tab=delivery', {
      session: 'admin',
      ...orgScope,
      handlers: handlers(never),
    });
    expect(await screen.findByRole('button', { name: 'Send email' })).toBeInTheDocument();
    expect(screen.getByLabelText('Send to')).toHaveValue('sam@example.com');
    expect(screen.getByRole('button', { name: 'Reload list' })).toBeInTheDocument();
  });
});

describe('pass detail: header actions', () => {
  it('needs the serial typed before deleting, then returns to the list', async () => {
    const user = userEvent.setup();
    const server = newServer();
    const { router } = await renderApp('/admin/passes/p1', {
      session: 'admin',
      ...orgScope,
      handlers: handlers(server, {
        '/api/v1/passes/p1': (_u, init) =>
          method(init) === 'DELETE' ? json({ ok: true }) : json(server.pass),
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'More' }));
    const entries = router.history.length;
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Sam Jones?' });
    const confirm = within(dialog).getByRole('button', { name: 'Delete' });
    expect(confirm).toBeDisabled();
    // The word is the pass title (human, at most 24 characters), matched case-insensitively.
    await user.type(within(dialog).getByLabelText('Type Sam Jones to confirm'), ' sam jones ');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/passes'));
    expect(server.calls.some((c) => c.method === 'DELETE')).toBe(true);
    // The deleted page leaves history: Back does not land on its not found.
    expect(router.history.length).toBe(entries);
  });

  it('voids and rotates the link after confirmation', async () => {
    const user = userEvent.setup();
    const server = newServer();
    await renderApp('/admin/passes/p1', {
      session: 'admin',
      ...orgScope,
      handlers: handlers(server, {
        '/api/v1/passes/p1/void': () => json(passSummary({ status: 'voided' })),
        '/api/v1/passes/p1/rotate-link': () =>
          json({ downloadUrl: '/p/new/pass.pkpass', publicUrl: '/p/new' }),
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Void' }));
    expect(server.calls.some((c) => c.path === '/api/v1/passes/p1/void')).toBe(false);
    const ask = await screen.findByRole('alertdialog');
    await user.click(within(ask).getByRole('button', { name: 'Void' }));
    await waitFor(() =>
      expect(server.calls.some((c) => c.path === '/api/v1/passes/p1/void')).toBe(true),
    );
    await user.click(screen.getByRole('button', { name: 'More' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rotate link' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Rotate' }));
    await waitFor(() =>
      expect(server.calls.some((c) => c.path === '/api/v1/passes/p1/rotate-link')).toBe(true),
    );
  });

  it('undoes an unvoid through the same Void pass? confirm, never around it', async () => {
    const user = userEvent.setup();
    const server = newServer({ status: 'voided' });
    await renderApp('/admin/passes/p1', {
      session: 'admin',
      ...orgScope,
      handlers: handlers(server, {
        '/api/v1/passes/p1/unvoid': () => {
          server.pass = { ...server.pass, status: 'active' };
          return json(passSummary({ status: 'active' }));
        },
        '/api/v1/passes/p1/void': () => json(passSummary({ status: 'voided' })),
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Unvoid' }));
    const toast = (await screen.findByText('Pass unvoided')).closest('[data-sonner-toast]');
    await user.click(within(toast as HTMLElement).getByRole('button', { name: 'Undo' }));
    const ask = await screen.findByRole('alertdialog', { name: 'Void pass?' });
    expect(server.calls.some((c) => c.path === '/api/v1/passes/p1/void')).toBe(false);
    await user.click(within(ask).getByRole('button', { name: 'Void' }));
    await waitFor(() =>
      expect(server.calls.some((c) => c.path === '/api/v1/passes/p1/void')).toBe(true),
    );
  });

  it('opens the public page in a new tab without a referrer', async () => {
    await renderApp('/admin/passes/p1', {
      session: 'admin',
      ...orgScope,
      handlers: handlers(newServer()),
    });
    await screen.findByRole('button', { name: 'More' });
    const link = screen.getByRole('link', { name: /Open\s*public page/ });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
  });

  it('shows not found with a way back, and no retry', async () => {
    await renderApp('/admin/passes/p1', {
      session: 'admin',
      ...orgScope,
      handlers: {
        '/api/v1/orgs': () => json({ items: [], nextCursor: null }),
        '/api/v1/passes/p1': () => problem(404, 'not_found', 'Pass not found.'),
      },
    });
    expect(await screen.findByText('Pass not found')).toBeInTheDocument();
    // The page keeps its header: title and the way up.
    expect(screen.getByRole('heading', { level: 1, name: 'Pass' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to passes' })).toHaveAttribute(
      'href',
      '/admin/passes?orgId=org1',
    );
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('shows an error with retry for server failures', async () => {
    await renderApp('/admin/passes/p1', {
      session: 'admin',
      ...orgScope,
      handlers: {
        '/api/v1/orgs': () => json({ items: [], nextCursor: null }),
        '/api/v1/passes/p1': () => problem(500, 'internal', 'Boom.'),
      },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('offers the .pkpass download from the detail header', async () => {
    await renderApp('/admin/passes/p1', {
      session: 'admin',
      ...orgScope,
      handlers: handlers(newServer()),
    });
    await userEvent.setup().click(await screen.findByRole('button', { name: 'More' }));
    const link = await screen.findByRole('menuitem', { name: 'Download .pkpass' });
    expect(link).toHaveAttribute('href', '/p/tok/pass.pkpass');
    expect(link).toHaveAttribute('download');
  });
});
