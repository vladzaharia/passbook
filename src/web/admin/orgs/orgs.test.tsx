import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { resetModeForTests, setMode } from '@/web/lib/mode.ts';
import { membershipsQuery, sessionQuery } from '@/web/lib/session.ts';
import {
  json,
  membershipFixture,
  problem,
  type RenderAppOptions,
  renderApp as renderBaseApp,
  sessionFixture,
} from '@/web/lib/test-utils.tsx';
import { toast } from '@/web/ui/index.ts';
import { templateSummary } from '../passes/test-fixtures.ts';
import { orgPatch, orgToDraft, validateOrg } from './org-form.tsx';
import { slugify } from './orgs-page.tsx';
import { samplePass } from './pass-branding.tsx';
import { passUpdateText } from './queries.ts';

const renderApp = renderBaseApp;

const summary = (over: Record<string, unknown> = {}) => ({
  id: 'o1',
  slug: 'acme',
  name: 'Acme Gym',
  status: 'active',
  defaultIdentityId: null,
  branding: { accent: '#0f766e', supportEmail: 'help@acme.test' },
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  counts: { passes: 12, templates: 2, connections: 1, apiKeys: 3 },
  countsCapped: false,
  ...over,
});

const provisioning = (over: Record<string, unknown> = {}) => {
  const { id, slug, name, status, createdAt, counts, countsCapped } = summary(over);
  return { id, slug, name, status, createdAt, counts, countsCapped };
};

const identity = (over: Record<string, unknown> = {}) => ({
  id: 'platform',
  orgId: null,
  label: 'Platform signer',
  passTypeIdentifier: 'pass.example',
  teamIdentifier: 'TEAM',
  source: 'env',
  certSha256: null,
  certSubject: null,
  certSerial: null,
  notBefore: null,
  notAfter: null,
  daysRemaining: 5,
  apnsBinding: null,
  apnsAvailable: false,
  apnsHealth: 'unknown',
  nfcEnabled: false,
  isDefault: true,
  createdAt: 1_700_000_000_000,
  ...over,
});

const settingsEmpty = { items: [] };
const walletAccount = (url: URL) =>
  json({
    orgId: 'o1',
    mode: url.searchParams.get('mode'),
    provider: url.searchParams.get('provider'),
    accountId: null,
    revision: 0,
    state: 'absent',
    externalApprovalVerified: false,
    updatedAt: null,
  });

describe('slugify', () => {
  it('makes URL-safe slugs', () => {
    expect(slugify('  Henry’s Gym & Spa! ')).toBe('henry-s-gym-spa');
    expect(slugify('Café Ünï')).toBe('cafe-uni');
    expect(slugify('---')).toBe('');
  });
});

describe('org form helpers', () => {
  it('validates name, accent and pass colours as a set', () => {
    const d = orgToDraft(summary() as never);
    expect(validateOrg(d)).toEqual({});
    expect(validateOrg({ ...d, name: ' ', accent: 'red' })).toEqual({
      name: 'Required.',
      accent: 'Use a 6-digit hex like #0f766e.',
    });
    expect(validateOrg({ ...d, background: '#000000' })).toEqual({
      foreground: 'Set all three colours.',
      label: 'Set all three colours.',
    });
  });

  it('does not invent template colors in an unbranded sample pass', () => {
    const org = summary() as never;
    const pass = samplePass(org, orgToDraft(org));
    expect(pass.backgroundColor).toBeUndefined();
    expect(pass.foregroundColor).toBeUndefined();
    expect(pass.labelColor).toBeUndefined();
  });

  it('keeps support contacts and images and drops cleared fields', () => {
    const org = summary({
      branding: {
        accent: '#0f766e',
        supportEmail: 'help@acme.test',
        icon: { sha: 'a'.repeat(64), w: 114, h: 114 },
      },
    }) as never;
    const d = { ...orgToDraft(org), accent: '', identity: 'i9' };
    expect(orgPatch(d, org)).toEqual({
      name: 'Acme Gym',
      defaultIdentityId: 'i9',
      branding: { supportEmail: 'help@acme.test', icon: { sha: 'a'.repeat(64), w: 114, h: 114 } },
    });
    expect(orgPatch({ ...d, identity: 'default' }, org).defaultIdentityId).toBeNull();
  });

  it('describes rebuild intent without promising a completed update', () => {
    expect(passUpdateText(1)).toBe('1 active pass marked for rebuild.');
    expect(passUpdateText(12)).toBe('12 active passes marked for rebuild.');
    expect(passUpdateText(0)).toBeUndefined();
  });
});

describe('orgs list', () => {
  it('lists orgs with monograms and counts, accessible', async () => {
    const { container } = await renderApp('/admin/orgs', {
      session: 'admin',
      memberships: [membershipFixture('o1', { orgName: 'Acme Gym' })],
      handlers: { '/api/v1/orgs': () => json({ items: [provisioning()], nextCursor: null }) },
    });
    expect(await screen.findByRole('link', { name: 'Acme Gym' })).toHaveAttribute(
      'href',
      '/admin/orgs/o1',
    );
    // Counts open each list scoped to the org.
    expect(screen.getByRole('link', { name: '12 passes in Acme Gym' })).toHaveAttribute(
      'href',
      '/admin/passes?orgId=o1',
    );
    expect(screen.getByText('1 organization')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Readiness' })).toBeNull();
    expect(screen.queryByText('Not available')).toBeNull();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('shows plain counts for an organization the admin is not a member of', async () => {
    await renderApp('/admin/orgs', {
      session: 'admin',
      handlers: { '/api/v1/orgs': () => json({ items: [provisioning()], nextCursor: null }) },
    });
    await screen.findByRole('link', { name: 'Acme Gym' });
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /passes in Acme Gym/ })).toBeNull();
  });

  it('identifies counts capped by the organization API as lower bounds', async () => {
    await renderApp('/admin/orgs', {
      session: 'admin',
      memberships: [membershipFixture('o1', { orgName: 'Acme Gym' })],
      handlers: {
        '/api/v1/orgs': () =>
          json({
            items: [
              provisioning({
                counts: { passes: 100_000, templates: 2, connections: 1, apiKeys: 3 },
                countsCapped: true,
              }),
            ],
            nextCursor: null,
          }),
      },
    });
    const count = await screen.findByRole('link', { name: 'At least 100,000 passes in Acme Gym' });
    expect(count.parentElement).toHaveTextContent('100,000+');
  });

  it('labels the mode used for pass counts without narrowing the directory', async () => {
    setMode('test');
    try {
      const { fetchMock } = await renderApp('/admin/orgs?orgId=o2', {
        session: 'admin',
        handlers: { '/api/v1/orgs': () => json({ items: [provisioning()], nextCursor: null }) },
      });
      expect(await screen.findByRole('link', { name: 'Acme Gym' })).toBeInTheDocument();
      const listRequest = fetchMock.mock.calls.find(([url]) =>
        String(url).includes('/api/v1/orgs?limit=50'),
      );
      expect(String(listRequest?.[0])).not.toContain('orgId=');
      expect(new Headers(listRequest?.[1]?.headers).get('x-passbook-mode')).toBe('test');
    } finally {
      resetModeForTests();
    }
  });

  it('searches with q and shows the filtered empty state', async () => {
    const { fetchMock, container } = await renderApp('/admin/orgs?q=zzz', {
      session: 'admin',
      handlers: { '/api/v1/orgs': () => json({ items: [], nextCursor: null }) },
    });
    expect(await screen.findByText('No organizations match')).toBeInTheDocument();
    expect(container.querySelector('[data-art="building"]')).not.toBeNull();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('q=zzz'))).toBe(true);
  });

  it('pages with Load more', async () => {
    await renderApp('/admin/orgs', {
      session: 'admin',
      handlers: {
        '/api/v1/orgs': (url) =>
          url.searchParams.get('cursor') === 'o1'
            ? json({ items: [summary({ id: 'o2', name: 'Bolt Club' })], nextCursor: null })
            : json({ items: [summary()], nextCursor: 'o1' }),
      },
    });
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('link', { name: 'Bolt Club' })).toBeInTheDocument();
    expect(screen.getByText('2 organizations')).toBeInTheDocument();
  });

  it('shows the empty state with the building', async () => {
    const { container } = await renderApp('/admin/orgs', { session: 'admin' });
    expect(await screen.findByText('No organizations')).toBeInTheDocument();
    expect(container.querySelector('[data-art="building"]')).not.toBeNull();
  });

  it('shows an error', async () => {
    await renderApp('/admin/orgs', {
      session: 'admin',
      handlers: { '/api/v1/orgs': () => problem(500, 'x', 'x') },
    });
    expect(await screen.findByText('Something went wrong. Try again.')).toBeInTheDocument();
  });

  it('opens the creation dialog from a deep link and consumes only the new flag', async () => {
    const { router } = await renderApp('/admin/orgs?q=acme&new=1', {
      session: 'admin',
      handlers: { '/api/v1/orgs': () => json({ items: [summary()], nextCursor: null }) },
    });
    const dialog = await screen.findByRole('dialog', { name: 'New organization' });
    expect(within(dialog).getByLabelText(/Name/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/Slug/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Create' })).toBeInTheDocument();
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/admin/orgs');
      expect(router.state.location.search).toMatchObject({ q: 'acme' });
      expect(router.state.location.search).not.toHaveProperty('new');
    });
    await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(router.state.location.search).toMatchObject({ q: 'acme' });
  });

  it('creates an org in an md dialog, clears fixed errors and opens the new org', async () => {
    let body: unknown;
    let created = false;
    const { router } = await renderApp('/admin/orgs', {
      session: 'admin',
      handlers: {
        '/api/v1/orgs': (_u, init) => {
          if (init?.method === 'POST') {
            body = JSON.parse(String(init.body));
            created = true;
            return json(summary({ id: 'o2' }), 201);
          }
          return json({
            items: created
              ? [provisioning({ id: 'o2', name: 'New' }), provisioning()]
              : [provisioning()],
            nextCursor: null,
          });
        },
        '/api/v1/orgs/o2': () => json(provisioning({ id: 'o2', name: 'Acme Gym' })),
        '/api/v1/orgs/o2/memberships': () => json({ items: [] }),
        '/api/v1/orgs/o2/invitations': () => json({ items: [] }),
        '/api/v1/identities': () => json({ items: [], nextCursor: null }),
        '/api/v1/settings': () => json(settingsEmpty),
      },
    });
    const ui = userEvent.setup();
    await ui.click(await screen.findByRole('button', { name: 'New organization' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.className).toContain('sm:max-w-lg');
    await ui.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await within(dialog).findByText('Required.')).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByLabelText(/Name/)));
    expect(await within(dialog).findByText('2 fields need attention')).toBeInTheDocument();
    await ui.type(within(dialog).getByLabelText(/Name/), 'Acme Gym');
    // The fix clears both errors as it is typed.
    expect(within(dialog).queryByText('Required.')).toBeNull();
    expect(within(dialog).getByLabelText(/Name/)).not.toHaveAttribute('aria-invalid');
    expect(within(dialog).getByLabelText(/Slug/)).toHaveValue('acme-gym');
    expect(within(dialog).getByLabelText(/Slug/)).not.toHaveAttribute('aria-invalid');
    await ui.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(body).toEqual({ name: 'Acme Gym', slug: 'acme-gym' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/orgs/o2'));
    // The new org says so once, with the next steps; no toast.
    expect(await screen.findByText('Organization created')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add branding' })).toBeNull();
    expect(screen.queryByRole('status', { name: /Organization created/ })).toBeNull();
  });

  it('shows a slug conflict from the server', async () => {
    await renderApp('/admin/orgs', {
      session: 'admin',
      handlers: {
        '/api/v1/orgs': (_u, init) =>
          init?.method === 'POST'
            ? problem(409, 'slug_taken', 'Slug already in use.', [
                { path: 'slug', message: 'Taken.' },
              ])
            : json({ items: [], nextCursor: null }),
      },
    });
    const ui = userEvent.setup();
    await ui.click((await screen.findAllByRole('button', { name: 'New organization' }))[0]!);
    const dialog = await screen.findByRole('dialog');
    await ui.type(within(dialog).getByLabelText(/Name/), 'Acme');
    await ui.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await within(dialog).findByText('Taken.')).toBeInTheDocument();
    expect(within(dialog).getByText('Slug already in use.')).toBeInTheDocument();
  });
});

describe('org detail', () => {
  const renderApp = (path: string, options: RenderAppOptions = {}) =>
    renderBaseApp(`${path}${path.includes('?') ? '&' : '?'}view=workspace`, {
      memberships: [membershipFixture('o1')],
      selectedOrg: 'o1',
      ...options,
      handlers: {
        '/api/v1/wallet-providers/accounts': walletAccount,
        ...options.handlers,
        '/api/v1/orgs/o1/workspace':
          options.handlers?.['/api/v1/orgs/o1/workspace'] ??
          options.handlers?.['/api/v1/orgs/o1'] ??
          (() => json(summary())),
      },
    });
  const handlers = (extra: Record<string, never> = {}) => ({
    '/api/v1/orgs/o1': () => json(summary()),
    '/api/v1/wallet-providers/accounts': walletAccount,
    '/api/v1/orgs/o1/memberships': () => json({ items: [] }),
    '/api/v1/orgs/o1/invitations': () => json({ items: [] }),
    '/api/v1/identities': () => json({ items: [], nextCursor: null }),
    '/api/v1/settings': () => json(settingsEmpty),
    ...extra,
  });

  it('keeps an unassociated platform administrator in provisioning, without tenant actions', async () => {
    const { fetchMock } = await renderBaseApp('/admin/orgs/o1', {
      session: 'admin',
      memberships: [],
      handlers: { '/api/v1/orgs/o1': () => json(provisioning()) },
    });
    expect(await screen.findByRole('heading', { name: 'Acme Gym', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Suspend' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invite organization admin' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        name: 'Platform provisioning: first organization administrator',
      }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Accent colour')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'People & service access' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(
      fetchMock.mock.calls.some(
        ([url]) =>
          String(url).includes('/workspace') || String(url).includes('/wallet-providers/accounts'),
      ),
    ).toBe(false);
  });

  it('mounts wallet accounts for the selected tenant workspace only', async () => {
    const { fetchMock } = await renderApp('/admin/orgs/o1', {
      session: 'admin',
      handlers: handlers(),
    });
    await screen.findByRole('heading', { name: 'Acme Gym', level: 1 });
    await waitFor(() => {
      const accounts = fetchMock.mock.calls
        .map(([url]) => new URL(String(url), 'http://localhost'))
        .filter((url) => url.pathname === '/api/v1/wallet-providers/accounts');
      expect(new Set(accounts.map((url) => url.searchParams.get('provider')))).toEqual(
        new Set(['google', 'samsung']),
      );
      expect(accounts.every((url) => url.searchParams.get('orgId') === 'o1')).toBe(true);
    });
  });

  it('does not treat a member visiting the bare platform route as workspace access', async () => {
    const { fetchMock } = await renderBaseApp('/admin/orgs/o1', {
      session: 'user',
      memberships: [membershipFixture('o1')],
      handlers: handlers(),
    });
    expect(
      await screen.findByRole('heading', {
        name: /You do not have access|Organization not found/,
      }),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([url]) =>
          String(url).includes('/workspace') || String(url).includes('/wallet-providers/accounts'),
      ),
    ).toBe(false);
  });

  it.each(['admin', 'user'] as const)(
    'does not treat duplicated workspace views as tenant access for %s',
    async (session) => {
      const { fetchMock } = await renderBaseApp(
        '/admin/orgs/o1?view=workspace&view=workspace&orgId=o1',
        { session, memberships: [membershipFixture('o1')], handlers: handlers() },
      );
      if (session === 'admin') {
        expect(await screen.findByRole('heading', { name: 'Acme Gym' })).toBeInTheDocument();
      } else {
        expect(
          await screen.findByRole('heading', {
            name: /You do not have access|Organization not found/,
          }),
        ).toBeInTheDocument();
      }
      expect(
        fetchMock.mock.calls.some(
          ([url]) =>
            String(url).includes('/workspace') ||
            String(url).includes('/wallet-providers/accounts'),
        ),
      ).toBe(false);
    },
  );

  it.each(['admin', 'user'] as const)(
    'validates %s resource membership before canonicalizing an unscoped workspace link',
    async (session) => {
      localStorage.removeItem('wallet-org-filter');
      let resolveMemberships!: () => void;
      const pending = new Promise<void>((resolve) => {
        resolveMemberships = resolve;
      });
      const { fetchMock, router } = await renderBaseApp('/admin/orgs/o1?view=workspace', {
        session,
        handlers: {
          ...handlers(),
          '/api/v1/orgs/memberships/me': async () => {
            await pending;
            return json({ items: [membershipFixture('o1')] });
          },
          '/api/v1/orgs/o1/workspace': () => json(summary()),
        },
      });
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(([url]) => String(url).includes('/orgs/memberships/me')),
        ).toBe(true),
      );
      expect(
        fetchMock.mock.calls.some(
          ([url]) =>
            String(url).includes('/orgs/o1/workspace') ||
            String(url).includes('/wallet-providers/accounts'),
        ),
      ).toBe(false);
      await act(async () => resolveMemberships());
      expect(
        await screen.findByRole('heading', { name: 'Acme Gym', level: 1 }),
      ).toBeInTheDocument();
      expect(router.state.location.search).toMatchObject({ view: 'workspace', orgId: 'o1' });
    },
  );

  it('does not load workspace data when fresh membership revalidation revokes access', async () => {
    let requests = 0;
    let resolveMemberships!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolveMemberships = resolve;
    });
    const { fetchMock } = await renderBaseApp('/admin/orgs/o1?view=workspace&orgId=o1', {
      session: 'admin',
      handlers: {
        ...handlers(),
        '/api/v1/orgs/memberships/me': async () => {
          requests += 1;
          if (requests === 1) return json({ items: [membershipFixture('o1')] });
          await pending;
          return json({ items: [] });
        },
        '/api/v1/orgs/o1/workspace': () => json(summary()),
      },
    });
    await waitFor(() => expect(requests).toBeGreaterThanOrEqual(2));
    expect(
      fetchMock.mock.calls.some(
        ([url]) =>
          String(url).includes('/orgs/o1/workspace') ||
          String(url).includes('/wallet-providers/accounts'),
      ),
    ).toBe(false);
    await act(async () => resolveMemberships());
    expect(await screen.findByText('Organization not found')).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([url]) =>
          String(url).includes('/orgs/o1/workspace') ||
          String(url).includes('/wallet-providers/accounts'),
      ),
    ).toBe(false);
  });

  it.each(['o1', 'o2'])(
    'canonicalizes the requested workspace rather than trusting remembered %s scope',
    async (remembered) => {
      localStorage.setItem('wallet-org-filter', remembered);
      try {
        const { fetchMock, router } = await renderBaseApp('/admin/orgs/o1?view=workspace', {
          session: 'user',
          memberships: [membershipFixture('o1'), membershipFixture('o2')],
          handlers: { ...handlers(), '/api/v1/orgs/o1/workspace': () => json(summary()) },
        });
        expect(
          await screen.findByRole('heading', { name: 'Acme Gym', level: 1 }),
        ).toBeInTheDocument();
        expect(router.state.location.search).toMatchObject({ view: 'workspace', orgId: 'o1' });
        await waitFor(() => expect(localStorage.getItem('wallet-org-filter')).toBe('o1'));
        expect(
          fetchMock.mock.calls.some(([url]) => String(url).includes('/orgs/o1/workspace')),
        ).toBe(true);
      } finally {
        localStorage.removeItem('wallet-org-filter');
      }
    },
  );

  it.each(['orgId=o2', 'orgId=o1&orgId=o2'])(
    'rejects conflicting or duplicate explicit workspace scopes (%s)',
    async (query) => {
      localStorage.setItem('wallet-org-filter', 'o1');
      try {
        const { fetchMock } = await renderBaseApp(`/admin/orgs/o1?view=workspace&${query}`, {
          session: 'admin',
          memberships: [membershipFixture('o1'), membershipFixture('o2')],
          handlers: handlers(),
        });
        expect(await screen.findByText('Organization not found')).toBeInTheDocument();
        expect(
          fetchMock.mock.calls.some(
            ([url]) =>
              String(url).includes('/workspace') ||
              String(url).includes('/wallet-providers/accounts'),
          ),
        ).toBe(false);
      } finally {
        localStorage.removeItem('wallet-org-filter');
      }
    },
  );

  it('lets a read-only member inspect the actual workspace without management queries', async () => {
    const { fetchMock } = await renderBaseApp('/admin/orgs/o1?view=workspace&orgId=o1', {
      session: 'user',
      memberships: [
        membershipFixture('o1', {
          roles: ['read_only'],
          capabilities: ['org:read', 'members:read'],
        }),
      ],
      handlers: {
        ...handlers(),
        '/api/v1/orgs/o1/workspace': () => json(summary()),
        '/api/v1/settings': () =>
          json({
            items: [
              {
                scope: 'org:o1',
                key: 'support.email',
                value: 'desk@acme.test',
                updatedAt: null,
                updatedBy: null,
              },
            ],
          }),
      },
    });
    expect(await screen.findByRole('heading', { name: 'Acme Gym', level: 1 })).toBeInTheDocument();
    expect(await screen.findByText('desk@acme.test')).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([url]) => {
        const request = new URL(String(url), 'http://localhost');
        return (
          request.pathname === '/api/v1/settings' && request.searchParams.get('scope') === 'org:o1'
        );
      }),
    ).toBe(true);
    expect(screen.getByRole('heading', { name: 'Pass branding' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'People & service access' })).toBeNull();
    expect(screen.queryByLabelText('Accent colour')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Suspend' })).toBeNull();
    expect(screen.queryByRole('link', { name: /API keys in Acme Gym/ })).toBeNull();
    for (const path of [
      '/api/v1/orgs/o1/memberships',
      '/api/v1/orgs/o1/invitations',
      '/api/v1/identities',
      '/api/v1/templates',
    ]) {
      expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith(path))).toBe(false);
    }
  });

  it('lets an org manager edit branding without platform identity access or membership management', async () => {
    let saved: Record<string, unknown> | undefined;
    const { fetchMock } = await renderBaseApp('/admin/orgs/o1?view=workspace&orgId=o1', {
      session: 'user',
      memberships: [membershipFixture('o1', { capabilities: ['org:read', 'org:manage'] })],
      handlers: {
        ...handlers(),
        '/api/v1/orgs/o1/workspace': () => json(summary({ defaultIdentityId: 'saved-identity' })),
        '/api/v1/orgs/o1': (_url, init) => {
          if (init?.method === 'PATCH') saved = JSON.parse(String(init.body));
          return json(summary({ defaultIdentityId: 'saved-identity' }));
        },
      },
    });
    const name = await screen.findByLabelText(/^Name/);
    expect(screen.getByText('saved-identity')).toBeInTheDocument();
    expect(screen.queryByLabelText('Signing identity')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'People & service access' })).toBeNull();
    expect(screen.queryByTitle('Sample pass email')).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/v1/identities'))).toBe(
      false,
    );
    const user = userEvent.setup();
    await user.type(name, ' updated');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saved).toMatchObject({ name: 'Acme Gym updated' }));
    expect(saved).not.toHaveProperty('defaultIdentityId');
  });

  it('shows count links, the form and pass branding, accessible', async () => {
    const { container } = await renderApp('/admin/orgs/o1', {
      session: 'admin',
      memberships: [membershipFixture('o1', { orgName: 'Acme Gym' })],
      handlers: handlers(),
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Acme Gym' })).toBeInTheDocument();
    const passes = screen.getByRole('link', { name: '12 passes in Acme Gym' });
    // The link carries the org as the list scope.
    expect(passes).toHaveAttribute('href', '/admin/passes?orgId=o1');
    expect(screen.getByRole('link', { name: '3 API keys in Acme Gym' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^View / })).toBeNull();
    expect(screen.queryByLabelText('Status')).toBeNull();
    expect(screen.getByLabelText('Accent colour')).toHaveValue('#0f766e');
    expect(screen.getByRole('heading', { name: 'Pass branding' })).toBeInTheDocument();
    expect(screen.queryByText('Get started')).toBeNull();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('keeps platform provisioning separate from branding while membership is unresolved or absent', async () => {
    // The web test target is ES2023, which does not expose Promise.withResolvers.
    let resolveMemberships!: (response: Response) => void;
    const membershipResponse = new Promise<Response>((resolve) => {
      resolveMemberships = resolve;
    });
    const { fetchMock, queryClient } = await renderBaseApp('/admin/orgs/o1', {
      session: 'admin',
      memberships: [],
      handlers: {
        ...handlers(),
        '/api/v1/orgs/memberships/me': () => membershipResponse,
        '/api/v1/orgs/o1': () =>
          json(
            summary({
              branding: {
                passColors: { background: '#112233', foreground: '#ddeeff', label: '#aaccee' },
              },
            }),
          ),
      },
    });
    expect(await screen.findByRole('heading', { name: 'Acme Gym', level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Pass branding' })).toBeNull();
    expect(screen.queryByLabelText('Background')).toBeNull();
    expect(
      fetchMock.mock.calls.some(
        ([url]) => String(url).includes('/workspace') || String(url).includes('/api/v1/templates'),
      ),
    ).toBe(false);
    await act(async () => resolveMemberships(json({ items: [] })));
    await waitFor(() =>
      expect(queryClient.getQueryData(membershipsQuery.queryKey)).toEqual({ items: [] }),
    );
    expect(screen.queryByRole('heading', { name: 'Pass branding' })).toBeNull();
    expect(
      fetchMock.mock.calls.some(
        ([url]) => String(url).includes('/workspace') || String(url).includes('/api/v1/templates'),
      ),
    ).toBe(false);
  });

  it('keeps saved workspace branding editable without template read access', async () => {
    const membership = membershipFixture('o1');
    membership.capabilities = membership.capabilities.filter((cap) => cap !== 'templates:read');
    const branding = {
      passColors: { background: '#112233', foreground: '#ddeeff', label: '#aaccee' },
      logo: { sha: 'a'.repeat(64), w: 480, h: 150 },
    };
    let org = summary({ branding });
    let saved: unknown;
    const { fetchMock } = await renderApp('/admin/orgs/o1', {
      session: 'admin',
      memberships: [membership],
      handlers: {
        ...handlers(),
        '/api/v1/orgs/o1': (_url, init) => {
          if (init?.method === 'PATCH') {
            saved = JSON.parse(String(init.body));
            org = summary({ ...org, ...(saved as object) });
          }
          return json(org);
        },
      },
    });
    expect(
      await screen.findByText(
        /Template colours require template read access for this organization/,
      ),
    ).toHaveTextContent('Unset colours use sample defaults, not template colours.');
    const card = screen.getByRole('group', { name: 'Acme Gym membership card, front' });
    expect(card.style.getPropertyValue('--pc-bg')).toBe('rgb(17, 34, 51)');
    expect(card.style.getPropertyValue('--pc-fg')).toBe('rgb(221, 238, 255)');
    expect(card.style.getPropertyValue('--pc-label')).toBe('rgb(170, 204, 238)');
    expect(card.querySelector('img')).toHaveAttribute(
      'src',
      `/api/v1/orgs/o1/branding/logo/3x?v=${'a'.repeat(12)}`,
    );
    expect(within(card).getByText('Maya Chen')).toBeInTheDocument();
    const user = userEvent.setup();
    const background = screen.getByLabelText('Background');
    await user.clear(background);
    await user.type(background, '#445566');
    expect(card.style.getPropertyValue('--pc-bg')).toBe('rgb(68, 85, 102)');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(saved).toMatchObject({
        branding: {
          ...branding,
          passColors: { ...branding.passColors, background: '#445566' },
        },
      }),
    );
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/v1/templates'))).toBe(
      false,
    );
  });

  it('labels unbranded sample defaults when template read access is missing', async () => {
    const membership = membershipFixture('o1');
    membership.capabilities = membership.capabilities.filter((cap) => cap !== 'templates:read');
    const { fetchMock } = await renderApp('/admin/orgs/o1', {
      session: 'admin',
      memberships: [membership],
      handlers: handlers(),
    });
    expect(
      await screen.findByText(
        /Template colours require template read access for this organization/,
      ),
    ).toHaveTextContent('Unset colours use sample defaults, not template colours.');
    const card = screen.getByRole('group', { name: 'Acme Gym membership card, front' });
    expect(card.style.getPropertyValue('--pc-bg')).toBe('rgb(255, 255, 255)');
    expect(screen.getByLabelText('Background')).toHaveValue('');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/v1/templates'))).toBe(
      false,
    );
  });

  it.each([
    { reason: 'no membership', memberships: [] },
    {
      reason: 'a membership without organization read',
      memberships: [membershipFixture('o1', { capabilities: ['passes:read'] })],
    },
    { reason: 'a grant for another organization', memberships: [membershipFixture('o2')] },
    {
      reason: 'a revoked grant',
      memberships: [membershipFixture('o1', { revokedAt: 1_800_000_000_000 })],
    },
  ])('does not expose workspace branding with $reason', async ({ memberships }) => {
    const { fetchMock } = await renderBaseApp('/admin/orgs/o1?view=workspace&orgId=o1', {
      session: 'admin',
      memberships,
      handlers: handlers(),
    });
    expect(await screen.findByText('Organization not found')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Pass branding' })).toBeNull();
    expect(
      fetchMock.mock.calls.some(
        ([url]) => String(url).includes('/workspace') || String(url).includes('/api/v1/templates'),
      ),
    ).toBe(false);
  });

  it('keeps platform provisioning separate from branding when membership lookup fails', async () => {
    const { fetchMock } = await renderBaseApp('/admin/orgs/o1', {
      session: 'admin',
      handlers: {
        ...handlers(),
        '/api/v1/orgs/memberships/me': () => problem(500, 'unavailable', 'Unavailable.'),
      },
    });
    expect(await screen.findByRole('heading', { name: 'Acme Gym', level: 1 })).toBeInTheDocument();
    expect(await screen.findByText('Could not load organization access.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Pass branding' })).toBeNull();
    expect(
      fetchMock.mock.calls.some(
        ([url]) => String(url).includes('/workspace') || String(url).includes('/api/v1/templates'),
      ),
    ).toBe(false);
  });

  it('does not preview a foreign template returned by the scoped list', async () => {
    const { fetchMock, queryClient } = await renderApp('/admin/orgs/o1', {
      session: 'admin',
      memberships: [membershipFixture('o1')],
      handlers: {
        ...handlers(),
        '/api/v1/templates': () =>
          json({ items: [templateSummary({ id: 'foreign', orgId: 'o2' })], nextCursor: null }),
      },
    });
    await waitFor(() =>
      expect(queryClient.getQueryData(['admin', 'templates', 'for-org', 'o1'])).toBeDefined(),
    );
    expect(
      await screen.findByText(/Template colours are unavailable or still loading/),
    ).toHaveTextContent('Unset colours use sample defaults, not template colours.');
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('/api/v1/templates/previews')),
    ).toBe(false);
  });

  it.each([
    { name: 'organization', own: true, expected: 'own' },
    { name: 'shared', own: false, expected: 'shared' },
  ])('loads the $name template swatch in the viewed organization', async ({ own, expected }) => {
    const listScopes: (string | null)[] = [];
    const previews: { orgId: string | null; ids: string | null }[] = [];
    const { queryClient } = await renderApp('/admin/orgs/o1', {
      session: 'admin',
      memberships: [membershipFixture('o1'), membershipFixture('o2')],
      handlers: {
        ...handlers(),
        '/api/v1/templates': (url) => {
          listScopes.push(url.searchParams.get('orgId'));
          return json({
            items: [
              templateSummary({ id: 'foreign', orgId: 'o2' }),
              templateSummary({ id: 'shared', orgId: null, orgName: null }),
              ...(own ? [templateSummary({ id: 'own', orgId: 'o1' })] : []),
            ],
            nextCursor: null,
          });
        },
        '/api/v1/templates/previews': (url) => {
          previews.push({ orgId: url.searchParams.get('orgId'), ids: url.searchParams.get('ids') });
          return json({
            items: [
              {
                id: expected,
                passJson: {
                  backgroundColor: 'rgb(10, 20, 30)',
                  foregroundColor: 'rgb(240, 241, 242)',
                  labelColor: 'rgb(100, 110, 120)',
                },
                warnings: [],
                assetBaseUrl: '/a',
                assetNames: [],
              },
            ],
          });
        },
      },
    });
    const card = await screen.findByRole('group', { name: 'Acme Gym membership card, front' });
    await waitFor(() => expect(card.style.getPropertyValue('--pc-bg')).toBe('rgb(10, 20, 30)'));
    expect(card.style.getPropertyValue('--pc-fg')).toBe('rgb(240, 241, 242)');
    expect(card.style.getPropertyValue('--pc-label')).toBe('rgb(100, 110, 120)');
    expect(listScopes).toEqual(['o1']);
    expect(previews).toEqual([{ orgId: 'o1', ids: expected }]);
    expect(screen.queryByText(/Unset colours use sample defaults/)).toBeNull();

    const restricted = membershipFixture('o1');
    restricted.capabilities = restricted.capabilities.filter((cap) => cap !== 'templates:read');
    await act(async () => {
      queryClient.setQueryData(membershipsQuery.queryKey, {
        items: [restricted, membershipFixture('o2')],
      });
    });
    expect(
      await screen.findByText(
        /Template colours require template read access for this organization/,
      ),
    ).toBeInTheDocument();
    expect(card.style.getPropertyValue('--pc-bg')).toBe('rgb(255, 255, 255)');
    expect(listScopes).toEqual(['o1']);
    expect(previews).toEqual([{ orgId: 'o1', ids: expected }]);
  });

  it('shows saved signing evidence and offers only usable identities', async () => {
    let org = summary();
    let saved: unknown;
    await renderApp('/admin/orgs/o1', {
      session: 'admin',
      handlers: {
        ...handlers(),
        '/api/v1/orgs/o1': (_u, init) => {
          if (init?.method === 'PATCH') {
            saved = JSON.parse(String(init.body));
            org = summary({ defaultIdentityId: 'own', updatedAt: 1_700_000_000_001 });
          }
          return json(org);
        },
        '/api/v1/identities': () =>
          json({
            items: [
              identity(),
              identity({ id: 'own', orgId: 'o1', label: 'Acme signer', isDefault: false }),
              identity({ id: 'other', orgId: 'o2', label: 'Other signer', isDefault: false }),
            ],
            nextCursor: null,
          }),
      },
    });
    const ui = userEvent.setup();
    const link = await screen.findByRole('link', { name: 'Platform signer' });
    expect(link).toHaveAttribute('href', '/admin/identities/platform');
    expect(screen.getByText('5 days left')).toBeInTheDocument();
    expect(screen.getByText(/Existing passes keep their signer/)).toBeInTheDocument();
    expect(
      screen.queryByText(
        /Google Wallet and Samsung Wallet account setup and readiness are not available here/,
      ),
    ).toBeNull();
    await ui.click(screen.getByLabelText('Signing identity'));
    const options = screen.getByRole('listbox');
    expect(within(options).queryByRole('option', { name: 'Other signer' })).toBeNull();
    await ui.click(within(options).getByRole('option', { name: 'Acme signer' }));
    await ui.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saved).toMatchObject({ defaultIdentityId: 'own' }));
  });

  it('keeps the saved signer and other edits while identity loading is retried', async () => {
    let fail = true;
    await renderApp('/admin/orgs/o1', {
      session: 'admin',
      handlers: {
        ...handlers(),
        '/api/v1/orgs/o1': () => json(summary({ defaultIdentityId: 'own' })),
        '/api/v1/identities': () =>
          fail
            ? problem(500, 'identity_error', 'Identities unavailable.')
            : json({
                items: [identity({ id: 'own', orgId: 'o1', label: 'Acme signer' })],
                nextCursor: null,
              }),
      },
    });
    const ui = userEvent.setup();
    expect(await screen.findByText(/Identity options could not be loaded/)).toBeInTheDocument();
    expect(screen.getByLabelText('Signing identity')).toHaveTextContent(
      'Saved identity (details unavailable)',
    );
    await ui.type(screen.getByLabelText(/^Name/), ' draft');
    fail = false;
    await ui.click(screen.getByRole('button', { name: 'Retry identities' }));
    expect(await screen.findByRole('link', { name: 'Acme signer' })).toHaveAttribute(
      'href',
      '/admin/identities/own',
    );
    expect(screen.getByLabelText(/^Name/)).toHaveValue('Acme Gym draft');
    expect(screen.getByLabelText('Signing identity')).toHaveTextContent('Acme signer');
  });

  it('scopes the list when a count is opened', async () => {
    const { router, fetchMock } = await renderApp('/admin/orgs/o1', {
      session: 'admin',
      handlers: { ...handlers(), '/api/v1/passes': () => json({ items: [], nextCursor: null }) },
    });
    await userEvent.setup().click(await screen.findByRole('link', { name: /12 passes/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/passes'));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((c) => /\/api\/v1\/passes\?.*orgId=o1/.test(String(c[0]))),
      ).toBe(true),
    );
  });

  it('shows the checklist for a new org, with the template step checked', async () => {
    await renderApp('/admin/orgs/o1', {
      session: 'admin',
      handlers: {
        ...handlers(),
        '/api/v1/orgs/o1': () =>
          json(summary({ counts: { passes: 0, templates: 1, connections: 0, apiKeys: 0 } })),
      },
    });
    const list = await screen.findByRole('region', { name: 'Get started' });
    expect(within(list).getByText('(done)', { exact: false })).toBeInTheDocument();
    expect(within(list).getByRole('link', { name: /New pass/ })).toBeInTheDocument();
  });

  it('lets a platform admin invite an initial org admin without fetching the workspace or people lists', async () => {
    let body: unknown;
    const secret = 't'.repeat(43);
    const { container, fetchMock, queryClient } = await renderBaseApp('/admin/orgs/o1', {
      session: 'admin',
      memberships: [],
      handlers: {
        '/api/v1/orgs/o1': () => json(provisioning()),
        '/api/v1/orgs/o1/invitations': (_url, init) => {
          if (!init) throw new Error('Expected request init');
          expect(init.method).toBe('POST');
          body = JSON.parse(String(init.body));
          return json(
            {
              id: 'i1',
              orgId: 'o1',
              email: 'first@example.test',
              roles: ['org_admin'],
              createdAt: 1_700_000_000_000,
              expiresAt: 1_800_000_000_000,
              revokedAt: null,
              acceptedAt: null,
              token: secret,
            },
            201,
          );
        },
      },
    });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/^Administrator email/), 'first@example.test');
    await user.click(screen.getByRole('button', { name: 'Invite organization admin' }));
    expect(await screen.findByText('Administrator invitation sent.')).toBeInTheDocument();
    expect(body).toEqual({ email: 'first@example.test', roles: ['org_admin'] });
    expect(container).not.toHaveTextContent(secret);
    expect(
      JSON.stringify(
        queryClient
          .getMutationCache()
          .getAll()
          .map((entry) => entry.state.data),
      ),
    ).not.toContain(secret);
    expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/v1/orgs/o1/workspace')).toBe(
      false,
    );
    expect(
      fetchMock.mock.calls.some(([url]) => String(url) === '/api/v1/orgs/o1/memberships'),
    ).toBe(false);
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => String(url) === '/api/v1/orgs/o1/invitations' && init?.method === 'GET',
      ),
    ).toBe(false);
  });

  it.each(['success', 'failure'] as const)(
    'ignores a late bootstrap invitation %s after the principal changes',
    async (outcome) => {
      // The web test target is ES2023 and does not expose Promise.withResolvers.
      let resolve!: (response: Response) => void;
      const pending = new Promise<Response>((done) => {
        resolve = done;
      });
      let requests = 0;
      const { queryClient } = await renderBaseApp('/admin/orgs/o1', {
        session: 'admin',
        memberships: [],
        handlers: {
          '/api/v1/orgs/o1': () => json(provisioning()),
          '/api/v1/orgs/o1/invitations': () => {
            requests += 1;
            return pending;
          },
        },
      });
      const user = userEvent.setup();
      await user.type(await screen.findByLabelText(/^Administrator email/), 'first@example.test');
      await user.click(screen.getByRole('button', { name: 'Invite organization admin' }));
      await waitFor(() => expect(requests).toBe(1));
      const mutation = queryClient.getMutationCache().getAll()[0];
      expect(mutation).toBeDefined();

      const next = sessionFixture('admin');
      if (!next.authenticated) throw new Error('Expected an authenticated fixture.');
      act(() => {
        const updatedSession: typeof next = { ...next, user: { ...next.user, id: 'u2' } };
        queryClient.setQueryData(sessionQuery.queryKey, updatedSession);
        queryClient.setQueryData(['org-access', 'o1', 'invitations'], { items: [] });
      });
      await waitFor(() => expect(screen.getByLabelText(/^Administrator email/)).toHaveValue(''));
      const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
      await act(async () => {
        resolve(
          outcome === 'success'
            ? json(
                {
                  id: 'i1',
                  orgId: 'o1',
                  email: 'first@example.test',
                  roles: ['org_admin'],
                  createdAt: 1_700_000_000_000,
                  expiresAt: 1_800_000_000_000,
                  revokedAt: null,
                  acceptedAt: null,
                },
                201,
              )
            : problem(500, 'failed', 'Private server detail.'),
        );
      });
      await waitFor(() => expect(mutation?.state.status).toBe('success'));
      expect(mutation?.state.data).toBeUndefined();
      expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['org-access', 'o1'] });
      expect(queryClient.getQueryState(['org-access', 'o1', 'invitations'])?.isInvalidated).toBe(
        false,
      );
      expect(screen.queryByText('Administrator invitation sent.')).toBeNull();
      expect(screen.queryByText('Private server detail.')).toBeNull();
      expect(screen.getByLabelText(/^Administrator email/)).toHaveValue('');
      invalidate.mockRestore();
    },
  );

  it('retains a bootstrap invitation draft when the server refuses it', async () => {
    await renderBaseApp('/admin/orgs/o1', {
      session: 'admin',
      handlers: {
        '/api/v1/orgs/o1': () => json(provisioning()),
        '/api/v1/orgs/o1/invitations': () => problem(403, 'forbidden', 'Not allowed.'),
      },
    });
    const user = userEvent.setup();
    const email = await screen.findByLabelText(/^Administrator email/);
    await user.type(email, 'first@example.test');
    await user.click(screen.getByRole('button', { name: 'Invite organization admin' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(email).toHaveValue('first@example.test');
    expect(screen.queryByText('Administrator invitation sent.')).toBeNull();
  });

  it('does not allow bootstrap invitations while an organization is suspended', async () => {
    const { fetchMock } = await renderBaseApp('/admin/orgs/o1', {
      session: 'admin',
      handlers: { '/api/v1/orgs/o1': () => json(provisioning({ status: 'suspended' })) },
    });
    expect(await screen.findByRole('button', { name: 'Invite organization admin' })).toBeDisabled();
    expect(
      screen.getByText('Reactivate the organization before inviting an admin.'),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([url]) => String(url) === '/api/v1/orgs/o1/invitations'),
    ).toBe(false);
  });

  it('suspends at once and Undo reactivates', async () => {
    const posts: { status: string }[] = [];
    let status = 'active';
    const { fetchMock } = await renderBaseApp('/admin/orgs/o1', {
      session: 'admin',
      memberships: [membershipFixture('o1', { orgName: 'Acme Gym' })],
      handlers: {
        ...handlers(),
        '/api/v1/orgs/o1': () => json(provisioning({ status })),
        '/api/v1/orgs/o1/status': (_u, init) => {
          posts.push(JSON.parse(String(init?.body)));
          status = posts.at(-1)?.status ?? status;
          const {
            counts: _counts,
            countsCapped: _countsCapped,
            ...response
          } = provisioning({ status });
          return json(response);
        },
      },
    });
    const ui = userEvent.setup();
    expect(await screen.findByRole('link', { name: 'Manage identities' })).toHaveAttribute(
      'href',
      '/admin/identities',
    );
    expect(screen.getByRole('link', { name: '12 passes in Acme Gym' })).toHaveAttribute(
      'href',
      '/admin/passes?orgId=o1',
    );
    expect(screen.getByRole('link', { name: '3 API keys in Acme Gym' })).toHaveAttribute(
      'href',
      '/admin/api-keys?orgId=o1',
    );
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/v1/identities'))).toBe(
      false,
    );
    await ui.click(await screen.findByRole('button', { name: 'Suspend' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(posts).toEqual([{ status: 'suspended' }]));
    expect(await screen.findByText(/passes do not update/)).toBeInTheDocument();
    await ui.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(posts).toEqual([{ status: 'suspended' }, { status: 'active' }]));
    expect(await screen.findByRole('button', { name: 'Suspend' })).toBeInTheDocument();
  });

  it('keeps an organization draft when the workspace refreshes', async () => {
    let org = summary();
    const { queryClient } = await renderApp('/admin/orgs/o1', {
      session: 'admin',
      handlers: { ...handlers(), '/api/v1/orgs/o1': () => json(org) },
    });
    const ui = userEvent.setup();
    const name = await screen.findByLabelText(/^Name/);
    await ui.type(name, ' draft');
    org = summary({ status: 'suspended', updatedAt: org.updatedAt + 1 });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['orgs', 'workspace', 'o1'] });
    });
    expect(await screen.findByText(/passes do not update/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Name/)).toHaveValue('Acme Gym draft');
    expect(screen.getByRole('region', { name: 'Unsaved changes' })).toBeInTheDocument();
  });

  it('keeps the draft visible after a failed organization refresh and recovers on retry', async () => {
    let org = summary();
    let failRefresh = false;
    const { queryClient } = await renderApp('/admin/orgs/o1', {
      session: 'admin',
      handlers: {
        ...handlers(),
        '/api/v1/orgs/o1': () =>
          failRefresh ? problem(500, 'refresh_failed', 'Refresh failed.') : json(org),
      },
    });
    const ui = userEvent.setup();
    await ui.type(await screen.findByLabelText(/^Name/), ' draft');
    org = summary({ status: 'suspended', updatedAt: org.updatedAt + 1 });
    failRefresh = true;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['orgs', 'workspace', 'o1'] });
    });
    expect(await screen.findByText('Organization refresh failed')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Name/)).toHaveValue('Acme Gym draft');
    expect(screen.getByRole('region', { name: 'Unsaved changes' })).toBeInTheDocument();
    failRefresh = false;
    await ui.click(screen.getByRole('button', { name: 'Retry organization' }));
    expect(await screen.findByText(/passes do not update/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Name/)).toHaveValue('Acme Gym draft');
  });

  it('keeps a draft when an image is removed and saves against the refreshed branding', async () => {
    const branding = {
      accent: '#0f766e',
      supportEmail: 'help@acme.test',
      logo: { sha: 'a'.repeat(64), w: 480, h: 150 },
    };
    let org = summary({ branding });
    let saved: unknown;
    await renderApp('/admin/orgs/o1', {
      session: 'admin',
      handlers: {
        ...handlers(),
        '/api/v1/orgs/o1': (_u, init) => {
          if (init?.method === 'PATCH') {
            saved = JSON.parse(String(init.body));
            org = summary({ ...org, name: 'Acme Gym draft', updatedAt: org.updatedAt + 1 });
          }
          return json(org);
        },
        '/api/v1/orgs/o1/branding/logo': (_u, init) => {
          expect(init?.method).toBe('DELETE');
          org = summary({
            branding: { accent: '#0f766e', supportEmail: 'help@acme.test' },
            updatedAt: org.updatedAt + 1,
          });
          return json(org);
        },
      },
    });
    const ui = userEvent.setup();
    await ui.type(await screen.findByLabelText(/^Name/), ' draft');
    await ui.click(screen.getByRole('button', { name: 'Remove logo' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove logo' })).toBeNull());
    expect(screen.getByLabelText(/^Name/)).toHaveValue('Acme Gym draft');
    await ui.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(saved).toEqual({
        name: 'Acme Gym draft',
        defaultIdentityId: null,
        branding: { accent: '#0f766e', supportEmail: 'help@acme.test' },
      }),
    );
  });

  it('retains the draft and save affordance after a failed update', async () => {
    await renderApp('/admin/orgs/o1', {
      session: 'admin',
      handlers: {
        ...handlers(),
        '/api/v1/orgs/o1': (_u, init) =>
          init?.method === 'PATCH' ? problem(500, 'save_failed', 'Save failed.') : json(summary()),
      },
    });
    const ui = userEvent.setup();
    await ui.type(await screen.findByLabelText(/^Name/), ' draft');
    await ui.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Could not save/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Name/)).toHaveValue('Acme Gym draft');
    expect(screen.getByRole('region', { name: 'Unsaved changes' })).toBeInTheDocument();
  });

  it('keeps and focuses a server-refused field without discarding its draft', async () => {
    await renderApp('/admin/orgs/o1', {
      session: 'admin',
      handlers: {
        ...handlers(),
        '/api/v1/orgs/o1': (_u, init) =>
          init?.method === 'PATCH'
            ? problem(400, 'invalid', 'Invalid organization.', [
                { path: 'name', message: 'Name not allowed.' },
              ])
            : json(summary()),
      },
    });
    const ui = userEvent.setup();
    const name = await screen.findByLabelText(/^Name/);
    await ui.type(name, ' draft');
    await ui.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Name not allowed.')).toBeInTheDocument();
    await waitFor(() => expect(name).toHaveFocus());
    expect(name).toHaveValue('Acme Gym draft');
    expect(screen.getByRole('region', { name: 'Unsaved changes' })).toBeInTheDocument();
  });

  it('saves the form with a PATCH and no status', async () => {
    let body: unknown;
    await renderApp('/admin/orgs/o1', {
      session: 'admin',
      handlers: {
        ...handlers(),
        '/api/v1/orgs/o1': (_u, init) => {
          if (init?.method === 'PATCH') {
            body = JSON.parse(String(init.body));
            return json(summary({ name: 'Acme 2' }));
          }
          return json(summary());
        },
      },
    });
    const ui = userEvent.setup();
    const name = await screen.findByLabelText(/^Name/);
    await ui.clear(name);
    await ui.type(name, 'Acme 2');
    await ui.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(body).toEqual({
        name: 'Acme 2',
        defaultIdentityId: null,
        branding: { accent: '#0f766e', supportEmail: 'help@acme.test' },
      }),
    );
  });

  it('turns the buddy on in pass emails with Save: one org setting, nothing else', async () => {
    const puts: unknown[] = [];
    let buddy = false;
    const entries = () => ({
      ...settingsEmpty,
      items: [
        {
          scope: 'org:o1',
          key: 'email.buddy',
          value: buddy,
          default: false,
          updatedAt: null,
          updatedBy: null,
        },
      ],
    });
    await renderApp('/admin/orgs/o1', {
      session: 'admin',
      handlers: {
        ...handlers(),
        '/api/v1/settings': (_u, init) => {
          if (init?.method === 'PUT') {
            puts.push(JSON.parse(String(init.body)));
            buddy = true;
          }
          return json(entries());
        },
      },
    });
    const ui = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'Pass email' })).toBeInTheDocument();
    const toggle = await screen.findByRole('switch', { name: 'Buddy in pass emails' });
    expect(toggle).not.toBeChecked();
    expect(
      screen.getByText("The PassBook buddy sits beside the organization's name."),
    ).toBeInTheDocument();
    // The real email, rendered by the Worker, follows the switch before Save.
    const frame = () => screen.getByTitle('Sample pass email') as HTMLIFrameElement;
    expect(screen.getByText('Sample email')).toBeInTheDocument();
    expect(frame().getAttribute('src')).toMatch(/^\/api\/v1\/orgs\/o1\/email-preview\?buddy=0&v=/);
    await ui.click(toggle);
    expect(frame().getAttribute('src')).toMatch(/email-preview\?buddy=1&v=/);
    // Scripts never run in it.
    expect(frame().getAttribute('sandbox')).toBe('allow-same-origin');
    const bar = await screen.findByRole('region', { name: 'Unsaved changes' });
    await ui.click(within(bar).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(puts).toEqual([{ scope: 'org:o1', values: { 'email.buddy': true } }]),
    );
    expect(await screen.findByText('Saved', { selector: '[data-title]' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Buddy in pass emails' })).toBeChecked();
  });

  it('saves details, pass email and support contacts from one bar', async () => {
    const sent: string[] = [];
    const success = vi.spyOn(toast, 'success');
    let org = summary();
    const values: Record<string, unknown> = {};
    const item = (key: string) => ({
      scope: 'org:o1',
      key,
      value: values[key] ?? null,
      default: key === 'email.buddy' ? false : null,
      updatedAt: null,
      updatedBy: null,
    });
    await renderApp('/admin/orgs/o1', {
      session: 'admin',
      handlers: {
        ...handlers(),
        '/api/v1/orgs/o1': (_u, init) => {
          if (init?.method === 'PATCH') {
            sent.push('org');
            org = summary({ name: JSON.parse(String(init.body)).name, updatedAt: 2 });
          }
          return json(org);
        },
        '/api/v1/settings': (_u, init) => {
          if (init?.method === 'PUT') {
            const put = JSON.parse(String(init.body)).values;
            sent.push(...Object.keys(put));
            Object.assign(values, put);
          }
          return json({
            ...settingsEmpty,
            items: ['email.buddy', 'support.email', 'support.url'].map(item),
          });
        },
      },
    });
    const ui = userEvent.setup();
    const name = await screen.findByLabelText(/^Name/);
    await ui.type(name, ' 2');
    await ui.click(await screen.findByRole('switch', { name: 'Buddy in pass emails' }));
    await ui.type(await screen.findByLabelText(/Support email/), 'help@acme.test');
    expect(screen.getAllByRole('region', { name: 'Unsaved changes' })).toHaveLength(1);
    await ui.click(screen.getByRole('button', { name: 'Save' }));
    // Top to bottom, one after another.
    await waitFor(() => expect(sent).toEqual(['org', 'email.buddy', 'support.email']));
    await waitFor(() => expect(success).toHaveBeenCalledOnce());
    expect(success).toHaveBeenCalledWith('Saved');
    success.mockRestore();
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull(),
    );
  });

  it('rejects a bad accent on Save, focusing it, without calling the API', async () => {
    let patched = false;
    await renderApp('/admin/orgs/o1', {
      session: 'admin',
      handlers: {
        ...handlers(),
        '/api/v1/orgs/o1': (_u, init) => {
          if (init?.method === 'PATCH') patched = true;
          return json(summary());
        },
      },
    });
    const ui = userEvent.setup();
    const accent = await screen.findByLabelText('Accent colour');
    await ui.clear(accent);
    await ui.type(accent, 'teal');
    // No error while typing; Save shows it, focuses the field and says how many.
    expect(screen.queryByText('Use a 6-digit hex like #0f766e.')).toBeNull();
    await ui.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Use a 6-digit hex like #0f766e.')).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(accent));
    expect(await screen.findByText('1 field needs attention')).toBeInTheDocument();
    expect(patched).toBe(false);
  });

  it('requires typing the slug before delete, then replaces the page in history', async () => {
    let deleted = false;
    const { router } = await renderBaseApp('/admin/orgs/o1', {
      session: 'admin',
      handlers: {
        ...handlers(),
        '/api/v1/orgs/o1': (_u, init) => {
          if (init?.method === 'DELETE') {
            deleted = true;
            return json({ ok: true });
          }
          return json(provisioning());
        },
        '/api/v1/orgs': () => json({ items: [], nextCursor: null }),
      },
    });
    const ui = userEvent.setup();
    const more = await screen.findByRole('button', { name: 'More' });
    await ui.click(more);
    await ui.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    let dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Type acme to confirm')).toHaveFocus();
    await ui.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(more).toHaveFocus());
    expect(deleted).toBe(false);
    await ui.click(more);
    await ui.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Delete' });
    expect(confirm).toBeDisabled();
    expect(within(dialog).getByText(/This cannot be undone\./)).toBeInTheDocument();
    expect(within(dialog).getByText(/offline Wallet copies are not erased/)).toBeInTheDocument();
    await ui.type(within(dialog).getByLabelText('Type acme to confirm'), 'acme');
    await ui.click(confirm);
    await waitFor(() => expect(deleted).toBe(true));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/orgs'));
    expect(router.history.length).toBe(1);
  });

  it('shows not found', async () => {
    await renderBaseApp('/admin/orgs/nope', { session: 'admin' });
    expect(await screen.findByText('Organization not found')).toBeInTheDocument();
  });
});
