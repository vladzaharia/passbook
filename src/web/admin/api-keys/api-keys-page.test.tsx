import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { resetModeForTests, setMode } from '@/web/lib/mode.ts';
import { json, membershipFixture, problem, renderApp } from '@/web/lib/test-utils.tsx';
import { keyState } from './api-keys-page.tsx';

afterEach(() => vi.unstubAllGlobals());

const key = (over: Record<string, unknown> = {}) => ({
  id: 'k1',
  orgId: null,
  name: 'CI key',
  prefix: 'abc123',
  scopes: ['passes:read'],
  createdBy: 'u1',
  createdByName: 'Ada Lovelace',
  createdAt: 1_700_000_000_000,
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  ...over,
});
const org = (id: string, name: string) => ({
  id,
  slug: id,
  name,
  status: 'active',
  defaultIdentityId: null,
  branding: {},
  createdAt: 1,
  updatedAt: 1,
  counts: { passes: 0, templates: 0, connections: 0, apiKeys: 0 },
  countsCapped: false,
});

describe('keyState', () => {
  it('prefers revoked over expired', () => {
    const base = key() as never;
    expect(keyState({ ...(base as object), revokedAt: 1, expiresAt: 1 } as never, 10)).toBe(
      'revoked',
    );
    expect(keyState({ ...(base as object), expiresAt: 5 } as never, 10)).toBe('expired');
    expect(keyState(base, 10)).toBe('active');
  });
});

const page = (items: unknown[], extra: Record<string, unknown> = {}) =>
  json({ items, nextCursor: null, revokedCount: 0, ...extra });

describe('api keys page', () => {
  it('lists keys, accessible', async () => {
    const { container } = await renderApp('/admin/api-keys', {
      session: 'admin',
      handlers: {
        '/api/v1/api-keys': (url) =>
          url.searchParams.get('state') === 'revoked'
            ? page([key({ id: 'k2', name: 'Old', revokedAt: 5 })])
            : page([key()], { revokedCount: 1 }),
      },
    });
    expect(await screen.findByText('CI key')).toBeInTheDocument();
    expect(screen.getAllByText('wlt_abc123', { exact: false })[0]).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Expiry' })).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    // Active first; the revoked key waits behind the toggle.
    expect(screen.queryByText('Old')).toBeNull();
    expect(screen.getByRole('link', { name: 'Ada Lovelace' })).toHaveAttribute(
      'href',
      '/admin/users/u1',
    );
    expect(screen.getByText('1 API key')).toBeInTheDocument();
    expect(container.querySelector('tbody button.border')).toBeNull();
    expect((await axe(container)).violations).toEqual([]);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Show revoked (1)' }));
    expect(screen.getByText('Old')).toBeInTheDocument();
  });

  it('defaults to platform keys rather than a remembered tenant selection', async () => {
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k === 'wallet-org-filter' ? 'o1' : null),
      setItem: () => {},
      removeItem: () => {},
    });
    const seen: string[] = [];
    const { router } = await renderApp('/admin/api-keys', {
      session: 'admin',
      memberships: [membershipFixture('o1')],
      handlers: {
        '/api/v1/api-keys': (url) => {
          seen.push(url.searchParams.get('orgId') ?? '');
          return page([key()]);
        },
      },
    });
    expect(await screen.findByText('CI key')).toBeInTheDocument();
    await waitFor(() => expect(seen.at(-1)).toBe('null'));
    expect(router.state.location.search.orgId).toBeUndefined();
    expect(screen.getByText('Platform-wide · All modes')).toBeInTheDocument();
  });

  it('shows the key empty state', async () => {
    const { container } = await renderApp('/admin/api-keys', {
      session: 'admin',
      handlers: { '/api/v1/api-keys': () => page([]) },
    });
    expect(await screen.findByText('No API keys')).toBeInTheDocument();
    expect(container.querySelector('[data-art="key"]')).not.toBeNull();
  });

  it('shows an error state', async () => {
    await renderApp('/admin/api-keys', {
      session: 'admin',
      handlers: { '/api/v1/api-keys': () => problem(500, 'x', 'x') },
    });
    expect(await screen.findByText('Something went wrong. Try again.')).toBeInTheDocument();
  });

  it('creates a key and shows the secret once', async () => {
    let body: Record<string, unknown> = {};
    await renderApp('/admin/api-keys', {
      session: 'admin',
      handlers: {
        '/api/v1/api-keys': (_u, init) => {
          if (init?.method === 'POST') {
            body = JSON.parse(String(init.body));
            return json({ ...key(), secret: 'wlt_abc123_SECRETVALUE' }, 201);
          }
          return page([]);
        },
      },
    });
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole('button', { name: 'New API key' }))[0]!);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.className).toContain('sm:max-w-lg');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await within(dialog).findByText('Required.')).toBeInTheDocument();
    expect(within(dialog).getByText('Pick at least one scope.')).toBeInTheDocument();
    expect(within(dialog).getByText('Platform-wide')).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText(/Name/), 'CI key');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Read passes' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    let review = await screen.findByRole('alertdialog', { name: 'Create a platform-wide key?' });
    expect(body).toEqual({});
    expect(within(review).getByText(/all organizations in Live mode/)).toBeInTheDocument();
    await user.click(within(review).getByRole('button', { name: 'Cancel' }));
    expect(within(dialog).getByLabelText(/Name/)).toHaveValue('CI key');
    expect(within(dialog).getByRole('checkbox', { name: 'Read passes' })).toBeChecked();
    expect(body).toEqual({});
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    review = await screen.findByRole('alertdialog', { name: 'Create a platform-wide key?' });
    await user.click(within(review).getByRole('button', { name: 'Create key' }));
    await waitFor(() => expect(body.name).toBe('CI key'));
    expect(body.scopes).toEqual(['passes:read']);
    expect(body.orgId).toBeNull();
    expect(body.mode).toBe('live');
    expect(typeof body.expiresAt).toBe('number');
    const reveal = await screen.findByRole('dialog', { name: /Copy your key/ });
    expect(reveal.querySelector('.wl-turn')).not.toBeNull();
    expect(reveal.querySelectorAll('.wl-sheen-once')).toHaveLength(1);
    expect(reveal.querySelector('[data-verb-done] svg.lucide-key-round')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Copy API key' })).toBeInTheDocument();
    expect(within(reveal).getByText('passes:read')).toBeInTheDocument();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const secret = within(reveal).getByLabelText('API key');
    expect(secret).not.toHaveTextContent('SECRETVALUE');
    await user.click(within(reveal).getByRole('button', { name: 'Show API key' }));
    expect(secret).toHaveTextContent('wlt_abc123_SECRETVALUE');
    await user.click(within(reveal).getByRole('button', { name: 'Copy API key' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('wlt_abc123_SECRETVALUE'));
    const done = screen.getByRole('button', { name: 'Done' });
    expect(done).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'I saved the key' }));
    await user.click(done);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('opens organization keys from an authorized workspace link', async () => {
    const north = org('o1', 'North');
    const seen: string[] = [];
    const { router } = await renderApp('/admin/orgs/o1?view=workspace&orgId=o1', {
      session: 'admin',
      memberships: [membershipFixture('o1', { orgName: 'North' })],
      handlers: {
        '/api/v1/orgs/o1/workspace': () => json(north),
        '/api/v1/orgs/o1/memberships': () => json({ items: [] }),
        '/api/v1/orgs/o1/invitations': () => json({ items: [] }),
        '/api/v1/identities': () => json({ items: [], nextCursor: null }),
        '/api/v1/settings': () =>
          json({
            items: [],
            oidc: { issuer: 'https://id.plrs.im', adminGroup: null, userGroup: null },
          }),
        '/api/v1/api-keys': (url) => {
          seen.push(url.searchParams.get('orgId') ?? '');
          return page([]);
        },
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: 'Review API keys' }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/\/admin\/api-keys\/?$/));
    expect(router.state.location.search.orgId).toBe('o1');
    await waitFor(() => expect(seen.at(-1)).toBe('o1'));
    expect(await screen.findByText('North · All modes')).toBeInTheDocument();
    await user.click((await screen.findAllByRole('button', { name: 'New API key' }))[0]!);
    expect(
      within(await screen.findByRole('dialog', { name: 'New API key' })).getByText('North'),
    ).toBeInTheDocument();
  });

  it('opens the palette action with the deep-linked organization preselected', async () => {
    let body: Record<string, unknown> = {};
    const seen: string[] = [];
    const { router } = await renderApp('/admin/api-keys?orgId=o1&new=1', {
      session: 'admin',
      memberships: [membershipFixture('o1', { orgName: 'North' })],
      handlers: {
        '/api/v1/api-keys': (url, init) => {
          if (init?.method === 'POST') {
            body = JSON.parse(String(init.body));
            return json({ ...key({ orgId: 'o1' }), secret: 'wlt_abc123_S' }, 201);
          }
          seen.push(url.searchParams.get('orgId') ?? '');
          return page([]);
        },
      },
    });
    const user = userEvent.setup();
    const dialog = await screen.findByRole('dialog', { name: 'New API key' });
    await waitFor(() => expect(router.state.location.search.new).toBeUndefined());
    expect(router.state.location.search.orgId).toBe('o1');
    await waitFor(() => expect(seen.at(-1)).toBe('o1'));
    expect(await screen.findByText('North · All modes')).toBeInTheDocument();
    expect(within(dialog).getByText('North')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/Name/), 'Org integration');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Read passes' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    const review = await screen.findByRole('alertdialog', { name: 'Review service key' });
    expect(within(review).getByText(/bound to North in Live mode/)).toBeInTheDocument();
    expect(body).toEqual({});
    await user.click(within(review).getByRole('button', { name: 'Create key' }));
    await waitFor(() => expect(body.orgId).toBe('o1'));
    expect(await screen.findByRole('dialog', { name: /Copy your key/ })).toBeInTheDocument();
  });

  it('consumes a palette creation request and can reopen the dialog normally', async () => {
    const { router } = await renderApp('/admin/api-keys?new=1', {
      session: 'admin',
      memberships: [],
      handlers: { '/api/v1/api-keys': () => page([]) },
    });
    const user = userEvent.setup();
    const dialog = await screen.findByRole('dialog', { name: 'New API key' });
    await waitFor(() => expect(router.state.location.search.new).toBeUndefined());
    expect(within(dialog).getByText('Platform-wide')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New API key' })).toBeNull());
    await user.click(screen.getAllByRole('button', { name: 'New API key' })[0]!);
    expect(await screen.findByRole('dialog', { name: 'New API key' })).toBeInTheDocument();
  });

  it('can open revoked keys when none are active', async () => {
    await renderApp('/admin/api-keys', {
      session: 'admin',
      handlers: {
        '/api/v1/api-keys': (url) =>
          url.searchParams.get('state') === 'revoked'
            ? page([key({ name: 'Old key', revokedAt: 5 })])
            : page([], { revokedCount: 1 }),
      },
    });
    expect(await screen.findByText('No active API keys')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Show revoked (1)' }));
    expect(await screen.findByText('Old key')).toBeInTheDocument();
  });

  it('marks Test keys with the pill and shows the real prefix', async () => {
    await renderApp('/admin/api-keys', {
      session: 'admin',
      handlers: {
        '/api/v1/api-keys': () => page([key({ id: 'k9', name: 'Sandbox key', mode: 'test' })]),
      },
    });
    expect(await screen.findByText('Sandbox key')).toBeInTheDocument();
    expect(screen.getByText('Test')).toBeInTheDocument();
    expect(screen.getByText('wlt_abc123')).toBeInTheDocument();
  });

  it('creates a Test key when Test mode is on', async () => {
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k === 'passbook-mode' ? 'test' : null),
      setItem: () => {},
      removeItem: () => {},
    });
    setMode('test');
    try {
      let body: Record<string, unknown> = {};
      await renderApp('/admin/api-keys', {
        session: 'admin',
        handlers: {
          '/api/v1/api-keys': (_u, init) => {
            if (init?.method === 'POST') {
              body = JSON.parse(String(init.body));
              return json({ ...key({ mode: 'test' }), secret: 'wlt_abc123_S' }, 201);
            }
            return page([]);
          },
        },
      });
      const user = userEvent.setup();
      await user.click((await screen.findAllByRole('button', { name: 'New API key' }))[0]!);
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/Passes made with a Test key/)).toBeInTheDocument();
      await user.type(within(dialog).getByLabelText(/Name/), 'T');
      await user.click(within(dialog).getByRole('checkbox', { name: 'Read passes' }));
      await user.click(within(dialog).getByRole('button', { name: 'Create' }));
      await user.click(
        within(
          await screen.findByRole('alertdialog', { name: 'Create a platform-wide key?' }),
        ).getByRole('button', { name: 'Create key' }),
      );
      await waitFor(() => expect(body.mode).toBe('test'));
    } finally {
      resetModeForTests();
      vi.unstubAllGlobals();
    }
  });

  it('shows a server error in the create dialog', async () => {
    await renderApp('/admin/api-keys', {
      session: 'admin',
      handlers: {
        '/api/v1/api-keys': (_u, init) =>
          init?.method === 'POST'
            ? problem(409, 'conflict', 'A key with this name exists.')
            : page([]),
      },
    });
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole('button', { name: 'New API key' }))[0]!);
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Name/), 'x');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Read passes' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    await user.click(
      within(
        await screen.findByRole('alertdialog', { name: 'Create a platform-wide key?' }),
      ).getByRole('button', { name: 'Create key' }),
    );
    expect(await within(dialog).findByText('A key with this name exists.')).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/Name/)).toHaveValue('x');
    expect(within(dialog).getByRole('checkbox', { name: 'Read passes' })).toBeChecked();
  });

  it('revokes from the row menu after confirmation and dims the row in place', async () => {
    let revoked = false;
    const { container } = await renderApp('/admin/api-keys', {
      session: 'admin',
      handlers: {
        '/api/v1/api-keys': () => page([key({ revokedAt: revoked ? 9 : null })]),
        '/api/v1/api-keys/k1': (_u, init) => {
          if (init?.method === 'DELETE') revoked = true;
          return json({ ok: true });
        },
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Actions for CI key' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Revoke' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(revoked).toBe(false);
    expect(within(dialog).getByText(/Organization: Platform-wide/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Mode: Live/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Permissions: passes:read/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(revoked).toBe(true));
    await waitFor(() =>
      expect(container.querySelector('[data-row-id="k1"] [data-revoked]')).not.toBeNull(),
    );
    expect(container.querySelector('[data-verb-done="undo"]')).not.toBeNull();
  });

  it('pages live keys with Load more', async () => {
    await renderApp('/admin/api-keys', {
      session: 'admin',
      handlers: {
        '/api/v1/api-keys': (url) =>
          url.searchParams.get('cursor') === 'k1'
            ? page([key({ id: 'k2', name: 'Second' })])
            : page([key()], { nextCursor: 'k1' }),
      },
    });
    expect(await screen.findByText('CI key')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Second')).toBeInTheDocument();
    expect(screen.getByText('2 API keys')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });
});
