import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { json, problem, renderApp } from '@/web/lib/test-utils.tsx';
import { toast } from '@/web/ui/index.ts';
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
});

describe('orgs list', () => {
  it('lists orgs with monograms and counts, accessible', async () => {
    const { container } = await renderApp('/admin/orgs', {
      session: 'admin',
      handlers: { '/api/v1/orgs': () => json({ items: [summary()], nextCursor: null }) },
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
    expect((await axe(container)).violations).toEqual([]);
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
            items: created ? [summary({ id: 'o2', name: 'New' }), summary()] : [summary()],
            nextCursor: null,
          });
        },
        '/api/v1/orgs/o2': () => json(summary({ id: 'o2', name: 'Acme Gym' })),
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
    expect(screen.getByRole('button', { name: 'Add branding' })).toBeInTheDocument();
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
  const handlers = (extra: Record<string, never> = {}) => ({
    '/api/v1/orgs/o1': () => json(summary()),
    '/api/v1/identities': () => json({ items: [], nextCursor: null }),
    '/api/v1/settings': () => json(settingsEmpty),
    ...extra,
  });

  it('shows count links, the form and pass branding, accessible', async () => {
    const { container } = await renderApp('/admin/orgs/o1', {
      session: 'admin',
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

  it('suspends at once and Undo reactivates', async () => {
    const posts: { status: string }[] = [];
    let status = 'active';
    await renderApp('/admin/orgs/o1', {
      session: 'admin',
      handlers: {
        ...handlers(),
        '/api/v1/orgs/o1': () => json(summary({ status })),
        '/api/v1/orgs/o1/status': (_u, init) => {
          posts.push(JSON.parse(String(init?.body)));
          status = posts.at(-1)?.status ?? status;
          return json(summary({ status }));
        },
      },
    });
    const ui = userEvent.setup();
    await ui.click(await screen.findByRole('button', { name: 'Suspend' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(posts).toEqual([{ status: 'suspended' }]));
    expect(await screen.findByText(/passes do not update/)).toBeInTheDocument();
    await ui.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(posts).toEqual([{ status: 'suspended' }, { status: 'active' }]));
    expect(await screen.findByRole('button', { name: 'Suspend' })).toBeInTheDocument();
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
    const { router } = await renderApp('/admin/orgs/o1', {
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
    expect(within(dialog).getByText(/This cannot be undone\./)).toBeInTheDocument();
    await ui.type(within(dialog).getByLabelText('Type acme to confirm'), 'acme');
    await ui.click(confirm);
    await waitFor(() => expect(deleted).toBe(true));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/orgs'));
    expect(router.history.length).toBe(1);
  });

  it('shows not found', async () => {
    await renderApp('/admin/orgs/nope', { session: 'admin' });
    expect(await screen.findByText('Organization not found')).toBeInTheDocument();
  });
});
