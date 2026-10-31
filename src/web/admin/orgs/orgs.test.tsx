import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { json, problem, renderApp } from '@/web/lib/test-utils.tsx';
import { orgPatch, orgToDraft, validateOrg } from './org-form.tsx';
import { slugify } from './orgs-page.tsx';

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

const settingsEmpty = {
  items: [],
  oidc: { issuer: 'https://id.plrs.im', adminGroup: null, userGroup: null },
};

describe('slugify', () => {
  it('makes URL-safe slugs', () => {
    expect(slugify('  Henry’s Gym & Spa! ')).toBe('henry-s-gym-spa');
    expect(slugify('Café Ünï')).toBe('cafe-uni');
    expect(slugify('---')).toBe('');
  });
});

describe('org form helpers', () => {
  it('validates name and accent', () => {
    const d = orgToDraft(summary() as never);
    expect(validateOrg(d)).toEqual({});
    expect(validateOrg({ ...d, name: ' ', accent: 'red' })).toEqual({
      name: 'Required.',
      accent: 'Use a 6-digit hex like #0f766e.',
    });
  });
  it('keeps support contacts and drops cleared branding fields', () => {
    const org = summary() as never;
    const d = { ...orgToDraft(org), accent: '', identity: 'i9' };
    expect(orgPatch(d, org)).toEqual({
      name: 'Acme Gym',
      status: 'active',
      defaultIdentityId: 'i9',
      branding: { supportEmail: 'help@acme.test' },
    });
    expect(orgPatch({ ...d, identity: 'default' }, org).defaultIdentityId).toBeNull();
  });
});

describe('orgs list', () => {
  it('lists orgs with counts, accessible', async () => {
    const { container } = await renderApp('/admin/orgs', {
      session: 'admin',
      handlers: { '/api/v1/orgs': () => json({ items: [summary()], nextCursor: null }) },
    });
    expect(await screen.findByRole('link', { name: 'Acme Gym' })).toHaveAttribute(
      'href',
      '/admin/orgs/o1',
    );
    expect(screen.getByText('12')).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('shows empty and error states', async () => {
    await renderApp('/admin/orgs', { session: 'admin' });
    expect(await screen.findByText('No organizations')).toBeInTheDocument();
  });

  it('shows an error', async () => {
    await renderApp('/admin/orgs', {
      session: 'admin',
      handlers: { '/api/v1/orgs': () => problem(500, 'x', 'x') },
    });
    expect(await screen.findByText('Server error. Try again.')).toBeInTheDocument();
  });

  it('creates an org with a slug derived from the name', async () => {
    let body: unknown;
    const { router } = await renderApp('/admin/orgs', {
      session: 'admin',
      handlers: {
        '/api/v1/orgs': (_u, init) => {
          if (init?.method === 'POST') {
            body = JSON.parse(String(init.body));
            return json(summary({ id: 'o2' }), 201);
          }
          return json({ items: [], nextCursor: null });
        },
        '/api/v1/orgs/o2': () => json(summary({ id: 'o2' })),
        '/api/v1/identities': () => json({ items: [] }),
        '/api/v1/settings': () => json(settingsEmpty),
      },
    });
    const ui = userEvent.setup();
    await ui.click((await screen.findAllByRole('button', { name: 'New organization' }))[0]!);
    const dialog = await screen.findByRole('dialog');
    await ui.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await within(dialog).findByText('Required.')).toBeInTheDocument();
    await ui.type(within(dialog).getByLabelText(/Name/), 'Acme Gym');
    expect(within(dialog).getByLabelText(/Slug/)).toHaveValue('acme-gym');
    await ui.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(body).toEqual({ name: 'Acme Gym', slug: 'acme-gym' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/orgs/o2'));
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
  const handlers = (extra: Record<string, never> = {}) => ({
    '/api/v1/orgs/o1': () => json(summary()),
    '/api/v1/identities': () => json({ items: [] }),
    '/api/v1/settings': () => json(settingsEmpty),
    ...extra,
  });

  it('shows counts and the form, accessible', async () => {
    const { container } = await renderApp('/admin/orgs/o1', {
      session: 'admin',
      handlers: handlers(),
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Acme Gym' })).toBeInTheDocument();
    const counts = screen.getByRole('list', { name: 'Counts' });
    expect(within(counts).getByText('12')).toBeInTheDocument();
    expect(screen.getByLabelText('Accent colour')).toHaveValue('#0f766e');
    expect(screen.queryByLabelText(/Logo/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View connections' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View API keys' })).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('saves branding changes with a PATCH', async () => {
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
    const name = await screen.findByLabelText(/Name/);
    await ui.clear(name);
    await ui.type(name, 'Acme 2');
    await ui.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(body).toEqual({
        name: 'Acme 2',
        status: 'active',
        defaultIdentityId: null,
        branding: { accent: '#0f766e', supportEmail: 'help@acme.test' },
      }),
    );
  });

  it('rejects a bad accent without calling the API', async () => {
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
    await ui.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Use a 6-digit hex like #0f766e.')).toBeInTheDocument();
    expect(patched).toBe(false);
  });

  it('requires typing the slug before delete', async () => {
    let deleted = false;
    await renderApp('/admin/orgs/o1', {
      session: 'admin',
      handlers: {
        ...handlers(),
        '/api/v1/orgs/o1': (_u, init) => {
          if (init?.method === 'DELETE') {
            deleted = true;
            return json({ ok: true });
          }
          return json(summary());
        },
        '/api/v1/orgs': () => json({ items: [], nextCursor: null }),
      },
    });
    const ui = userEvent.setup();
    await ui.click(await screen.findByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Delete' });
    expect(confirm).toBeDisabled();
    await ui.type(within(dialog).getByLabelText('Type acme to confirm'), 'acme');
    await ui.click(confirm);
    await waitFor(() => expect(deleted).toBe(true));
  });

  it('shows not found', async () => {
    await renderApp('/admin/orgs/nope', { session: 'admin' });
    expect(await screen.findByText('Organization not found')).toBeInTheDocument();
  });
});
