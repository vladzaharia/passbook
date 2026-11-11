import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  json,
  membershipFixture,
  problem,
  renderApp,
  sessionFixture,
} from '@/web/lib/test-utils.tsx';
import { ORG, SAMPLE_PASS_JSON, templateDetail, templateSummary } from '../passes/test-fixtures.ts';
import { broadcast } from './test-fixtures.ts';

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
afterEach(() => vi.unstubAllGlobals());

const MESSAGING = templateDetail({
  manifest: { inputs: templateDetail().inputSchema, messaging: { input: 'message' } },
});

type Handlers = Parameters<typeof renderApp>[1] extends infer O
  ? O extends { handlers?: infer H }
    ? NonNullable<H>
    : never
  : never;

function setup(
  path: string,
  extra: Handlers = {},
  preview: () => Response = () => json({ targeted: 1, onDevice: 1, overBudget: 0, limit: 3 }),
) {
  const created: unknown[] = [];
  const rendered = renderApp(path, {
    session: 'admin',
    memberships: [membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug })],
    selectedOrg: ORG.id,
    handlers: {
      '/api/v1/orgs': () => json({ items: [ORG], nextCursor: null }),
      '/api/v1/templates': () => json({ items: [templateSummary()], nextCursor: null }),
      '/api/v1/templates/tpl1': () => json(MESSAGING),
      '/api/v1/broadcasts/preview': preview,
      '/api/v1/broadcasts': (_u, init) => {
        created.push(JSON.parse(String(init?.body)));
        return json(broadcast({ id: 'b9', orgId: 'org1', state: 'sending' }), 201);
      },
      '/api/v1/broadcasts/b9': () => json(broadcast({ id: 'b9', orgId: 'org1', state: 'sending' })),
      '/api/v1/broadcasts/b9/items': () => json({ items: [], nextCursor: null }),
      ...extra,
    },
  });
  return { created, rendered };
}

async function writeMessage(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('checkbox', { name: 'Copper card' }));
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Doors open at 8.');
}

describe('Message composer', () => {
  it('requires an explicit choice even with a single authorized organization', async () => {
    const requests: string[] = [];
    await renderApp('/admin/messages/new', {
      session: 'admin',
      memberships: [membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug })],
      handlers: {
        '/api/v1/templates': (url) => {
          requests.push(url.searchParams.get('orgId') ?? 'unscoped');
          return json({ items: [templateSummary()], nextCursor: null });
        },
        '/api/v1/templates/tpl1': () => json(MESSAGING),
      },
    });
    expect(
      await screen.findByRole('heading', { name: 'Choose an organization' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send now' })).not.toBeInTheDocument();
    expect(requests).toEqual([]);

    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: /^Organization filter/ }));
    await user.click(await screen.findByRole('option', { name: ORG.name }));
    expect(await screen.findByRole('heading', { name: 'New message' })).toBeInTheDocument();
    await waitFor(() => expect(requests).toContain(ORG.id));
  });

  it('does not hydrate or query a draft while its organization is unknown or mismatched', async () => {
    const requests: string[] = [];
    const deferred = Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
    };
    const pendingDraft = deferred.withResolvers<Response>();
    const { queryClient } = await renderApp('/admin/messages/new?from=b5', {
      session: 'admin',
      memberships: [
        membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug }),
        membershipFixture('org2', { orgName: 'Harbor', orgSlug: 'harbor' }),
      ],
      selectedOrg: ORG.id,
      handlers: {
        '/api/v1/broadcasts/b5': (_url, init) => {
          requests.push(init?.method === 'PATCH' ? 'patch' : 'detail');
          return pendingDraft.promise;
        },
        '/api/v1/broadcasts/b5/send': () => {
          requests.push('send');
          return json(broadcast());
        },
        '/api/v1/templates': () => {
          requests.push('templates');
          return json({ items: [], nextCursor: null });
        },
        '/api/v1/broadcasts/preview': () => {
          requests.push('preview');
          return json({ targeted: 1, onDevice: 1, overBudget: 0, limit: 3 });
        },
      },
    });
    await waitFor(() => expect(requests).toEqual(['detail']));
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send now' })).not.toBeInTheDocument();
    await act(async () => {
      pendingDraft.resolve(
        json(
          broadcast({
            id: 'b5',
            orgId: 'org2',
            state: 'draft',
            name: 'Private draft',
            patch: { message: 'Private content' },
          }),
        ),
      );
    });
    expect(await screen.findByText('Message not found')).toBeInTheDocument();
    expect(screen.queryByText('Private draft')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('Private content')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save draft' })).not.toBeInTheDocument();
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'broadcasts', 'detail', 'b5'] });
    });
    expect(requests).toEqual(['detail']);
  });

  it('removes a previously loaded draft and its send confirmation on a scope switch', async () => {
    const writes: string[] = [];
    const draft = broadcast({
      id: 'b5',
      orgId: 'org2',
      state: 'draft',
      startedAt: null,
      target: { templateIds: ['tpl1'] },
      patch: { message: 'Harbor private content' },
    });
    const { router, queryClient } = await renderApp('/admin/messages/new?from=b5', {
      session: 'admin',
      memberships: [
        membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug }),
        membershipFixture('org2', { orgName: 'Harbor', orgSlug: 'harbor' }),
      ],
      selectedOrg: 'org2',
      handlers: {
        '/api/v1/broadcasts/b5': (_url, init) => {
          if (init?.method === 'PATCH') writes.push('patch');
          return json(draft);
        },
        '/api/v1/broadcasts/b5/send': () => {
          writes.push('send');
          return json(draft);
        },
        '/api/v1/templates': () =>
          json({ items: [templateSummary({ orgId: 'org2' })], nextCursor: null }),
        '/api/v1/templates/tpl1': () => json({ ...MESSAGING, orgId: 'org2' }),
        '/api/v1/broadcasts/preview': () =>
          json({ targeted: 1, onDevice: 1, overBudget: 0, limit: 3 }),
      },
    });
    expect(await screen.findByRole('textbox', { name: 'Message' })).toHaveValue(
      'Harbor private content',
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Send now' }));
    expect(await screen.findByRole('alertdialog', { name: 'Send to 1 pass?' })).toBeInTheDocument();

    await act(async () => {
      await router.navigate({
        to: '/admin/messages/new',
        search: { from: 'b5', orgId: ORG.id },
      });
    });
    expect(await screen.findByText('Message not found')).toBeInTheDocument();
    expect(queryClient.getQueryData(['admin', 'broadcasts', 'detail', 'b5'])).toMatchObject({
      orgId: 'org2',
    });
    expect(screen.queryByDisplayValue('Harbor private content')).not.toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send now' })).not.toBeInTheDocument();
    expect(writes).toEqual([]);

    await act(async () => {
      await router.navigate({
        to: '/admin/messages/new',
        search: { from: 'b5', orgId: 'org2' },
      });
    });
    expect(await screen.findByRole('textbox', { name: 'Message' })).toHaveValue(
      'Harbor private content',
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it.each([
    'scope',
    'capability',
    'capability race',
    'principal race',
    'response organization',
  ] as const)('does not send a patched draft after its %s changes', async (change) => {
    const deferred = Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
    };
    const patch = deferred.withResolvers<Response>();
    const writes: string[] = [];
    const draft = broadcast({
      id: 'b5',
      orgId: 'org2',
      state: 'draft',
      startedAt: null,
      target: { templateIds: ['tpl1'] },
      patch: { message: 'Harbor private content' },
    });
    const northwind = membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug });
    const harbor = membershipFixture('org2', { orgName: 'Harbor', orgSlug: 'harbor' });
    const { router, queryClient } = await renderApp('/admin/messages/new?from=b5', {
      session: 'admin',
      memberships: [northwind, harbor],
      selectedOrg: 'org2',
      handlers: {
        '/api/v1/broadcasts/b5': (_url, init) => {
          if (init?.method === 'PATCH') {
            writes.push('patch');
            return patch.promise;
          }
          return json(draft);
        },
        '/api/v1/broadcasts/b5/send': () => {
          writes.push('send');
          return json({ ...draft, state: 'sending' });
        },
        '/api/v1/templates': () =>
          json({ items: [templateSummary({ orgId: 'org2' })], nextCursor: null }),
        '/api/v1/templates/tpl1': () => json({ ...MESSAGING, orgId: 'org2' }),
        '/api/v1/broadcasts/preview': () =>
          json({ targeted: 1, onDevice: 1, overBudget: 0, limit: 3 }),
      },
    });
    const user = userEvent.setup();
    expect(await screen.findByRole('textbox', { name: 'Message' })).toHaveValue(
      'Harbor private content',
    );
    await user.click(screen.getByRole('button', { name: 'Send now' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Send to 1 pass?' });
    await user.click(within(confirm).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(writes).toEqual(['patch']));

    if (change === 'scope') {
      await act(async () => {
        await router.navigate({
          to: '/admin/messages/new',
          search: { from: 'b5', orgId: ORG.id },
        });
      });
      expect(await screen.findByText('Message not found')).toBeInTheDocument();
    } else if (change === 'capability') {
      await act(async () => {
        queryClient.setQueryData(['org-memberships', 'me'], {
          items: [northwind, { ...harbor, capabilities: ['messages:read', 'passes:operate'] }],
        });
      });
      expect(
        await screen.findByRole('heading', { name: 'You do not have access' }),
      ).toBeInTheDocument();
    }

    await act(async () => {
      if (change === 'capability race')
        queryClient.setQueryData(['org-memberships', 'me'], {
          items: [northwind, { ...harbor, capabilities: ['messages:read', 'passes:operate'] }],
        });
      if (change === 'principal race') {
        const next = sessionFixture('user');
        if (!next.authenticated) throw new Error('Expected an authenticated session');
        queryClient.setQueryData(['session'], { ...next, user: { ...next.user, id: 'u2' } });
      }
      patch.resolve(json(change === 'response organization' ? { ...draft, orgId: ORG.id } : draft));
      await patch.promise;
    });
    await waitFor(() => expect(queryClient.isMutating()).toBe(0));
    expect(writes).toEqual(['patch']);
  });

  it('does not navigate when a new message finishes after switching organizations', async () => {
    const deferred = Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
    };
    const create = deferred.withResolvers<Response>();
    const writes: unknown[] = [];
    const { router, queryClient } = await renderApp('/admin/messages/new', {
      session: 'user',
      memberships: [
        membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug }),
        membershipFixture('org2', { orgName: 'Harbor', orgSlug: 'harbor' }),
      ],
      selectedOrg: ORG.id,
      handlers: {
        '/api/v1/templates': () => json({ items: [templateSummary()], nextCursor: null }),
        '/api/v1/templates/tpl1': () => json(MESSAGING),
        '/api/v1/broadcasts/preview': () =>
          json({ targeted: 1, onDevice: 1, overBudget: 0, limit: 3 }),
        '/api/v1/broadcasts': (_url, init) => {
          if (init?.method !== 'POST') return json({ items: [], nextCursor: null });
          writes.push(JSON.parse(String(init.body)));
          return create.promise;
        },
      },
    });
    const user = userEvent.setup();
    await writeMessage(user);
    await user.click(screen.getByRole('button', { name: 'Send now' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Send to 1 pass?' });
    await user.click(within(confirm).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    await act(async () => {
      await router.navigate({
        to: '/admin/messages',
        search: { orgId: 'org2' },
        ignoreBlocker: true,
      });
    });
    await act(async () => {
      create.resolve(json(broadcast({ id: 'b9', orgId: ORG.id, state: 'sending' }), 201));
      await create.promise;
    });
    await waitFor(() => expect(queryClient.isMutating()).toBe(0));
    expect(router.state.location.pathname).toBe('/admin/messages');
    expect(router.state.location.search.orgId).toBe('org2');
  });

  it('clears a new composer after discarding changes and switching organizations', async () => {
    const { router } = await renderApp('/admin/messages/new', {
      session: 'admin',
      memberships: [
        membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug }),
        membershipFixture('org2', { orgName: 'Harbor', orgSlug: 'harbor' }),
      ],
      selectedOrg: ORG.id,
      handlers: {
        '/api/v1/templates': (url) =>
          json({
            items:
              url.searchParams.get('orgId') === 'org2'
                ? [templateSummary({ id: 'tpl2', orgId: 'org2', name: 'Harbor card' })]
                : [templateSummary()],
            nextCursor: null,
          }),
        '/api/v1/templates/tpl1': () => json(MESSAGING),
        '/api/v1/templates/tpl2': () => json({ ...MESSAGING, id: 'tpl2', orgId: 'org2' }),
        '/api/v1/broadcasts/preview': () =>
          json({ targeted: 1, onDevice: 1, overBudget: 0, limit: 3 }),
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox', { name: 'Copper card' }));
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Private first message');
    await user.click(screen.getByRole('combobox', { name: /^Organization filter/ }));
    await user.click(await screen.findByRole('option', { name: 'Harbor' }));
    const discard = await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' });
    await user.click(within(discard).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(router.state.location.search.orgId).toBe('org2'));
    expect(await screen.findByRole('checkbox', { name: 'Harbor card' })).not.toBeChecked();
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');
    expect(screen.queryByDisplayValue('Private first message')).not.toBeInTheDocument();
  });

  it('does not load a draft or composer for a read-only membership', async () => {
    const requests: string[] = [];
    await renderApp('/admin/messages/new?from=b5', {
      session: 'admin',
      memberships: [
        membershipFixture(ORG.id, { capabilities: ['messages:read', 'passes:operate'] }),
      ],
      selectedOrg: ORG.id,
      handlers: {
        '/api/v1/broadcasts/b5': () => {
          requests.push('detail');
          return json(broadcast({ id: 'b5', orgId: ORG.id, state: 'draft' }));
        },
      },
    });
    expect(
      await screen.findByRole('heading', { name: 'You do not have access' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument();
    expect(requests).toEqual([]);
  });

  it('uses shared templates in the selected context without loading foreign ones', async () => {
    const detailScopes: (string | null)[] = [];
    const foreignRequests: string[] = [];
    const previewBodies: unknown[] = [];
    await renderApp('/admin/messages/new', {
      session: 'admin',
      memberships: [membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug })],
      selectedOrg: ORG.id,
      handlers: {
        '/api/v1/templates': () =>
          json({
            items: [
              templateSummary({ orgId: null, orgName: null, name: 'Shared card' }),
              templateSummary({ id: 'foreign', orgId: 'org2', name: 'Private card' }),
            ],
            nextCursor: null,
          }),
        '/api/v1/templates/tpl1': (url) => {
          detailScopes.push(url.searchParams.get('orgId'));
          return json({ ...MESSAGING, orgId: null, orgName: null, name: 'Shared card' });
        },
        '/api/v1/templates/tpl1/preview': (_url, init) => {
          previewBodies.push(JSON.parse(String(init?.body)));
          return json({
            passJson: SAMPLE_PASS_JSON,
            warnings: [],
            assetBaseUrl: '/a',
            assetNames: [],
          });
        },
        '/api/v1/templates/foreign': () => {
          foreignRequests.push('detail');
          return json(templateDetail({ id: 'foreign', orgId: 'org2', name: 'Private card' }));
        },
        '/api/v1/broadcasts/preview': () =>
          json({ targeted: 1, onDevice: 1, overBudget: 0, limit: 3 }),
      },
    });
    const user = userEvent.setup();
    const shared = await screen.findByRole('checkbox', { name: 'Shared card' });
    await waitFor(() => expect(shared).toBeEnabled());
    expect(detailScopes).toContain(ORG.id);
    expect(detailScopes).not.toContain(null);
    expect(screen.queryByText('Private card')).not.toBeInTheDocument();
    expect(foreignRequests).toEqual([]);
    await user.click(shared);
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Hello');
    expect(await screen.findByText('1 pass, 1 on a device.')).toBeInTheDocument();
    await waitFor(() =>
      expect(previewBodies).toContainEqual(expect.objectContaining({ orgId: ORG.id })),
    );
  });

  it.each(['admin', 'user'] as const)(
    'sends as %s with message-management permission without a pass-operation grant',
    async (session) => {
      const created: unknown[] = [];
      await renderApp('/admin/messages/new', {
        session,
        memberships: [
          membershipFixture(ORG.id, {
            orgName: ORG.name,
            orgSlug: ORG.slug,
            capabilities: ['messages:read', 'messages:manage', 'templates:read'],
          }),
        ],
        selectedOrg: ORG.id,
        handlers: {
          '/api/v1/templates': () => json({ items: [templateSummary()], nextCursor: null }),
          '/api/v1/templates/tpl1': () => json(MESSAGING),
          '/api/v1/broadcasts/preview': () =>
            json({ targeted: 1, onDevice: 1, overBudget: 0, limit: 3 }),
          '/api/v1/broadcasts': (_url, init) => {
            created.push(JSON.parse(String(init?.body)));
            return json(broadcast({ id: 'b9', orgId: ORG.id, state: 'sending' }), 201);
          },
          '/api/v1/broadcasts/b9': () => json(broadcast({ id: 'b9', orgId: ORG.id })),
          '/api/v1/broadcasts/b9/items': () => json({ items: [], nextCursor: null }),
        },
      });
      const user = userEvent.setup();
      await writeMessage(user);
      await user.click(screen.getByRole('button', { name: 'Send now' }));
      const confirm = await screen.findByRole('alertdialog', { name: 'Send to 1 pass?' });
      await user.click(within(confirm).getByRole('button', { name: 'Send' }));
      await waitFor(() =>
        expect(created).toEqual([expect.objectContaining({ orgId: ORG.id, send: 'now' })]),
      );
    },
  );

  it('sends now and lands on the message', async () => {
    const { created } = setup('/admin/messages/new?orgId=org1');
    const user = userEvent.setup();
    await writeMessage(user);
    expect(await screen.findByText('1 pass, 1 on a device.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send now' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Send to 1 pass?' });
    await user.click(within(confirm).getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('heading', { name: 'Doors open late' })).toBeInTheDocument();
    expect(created).toEqual([
      expect.objectContaining({ orgId: 'org1', kind: 'message', send: 'now' }),
    ]);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('counts the audience once per settled edit, not per keystroke', async () => {
    const counts: unknown[] = [];
    setup('/admin/messages/new?orgId=org1', {}, () => {
      counts.push(1);
      return json({ targeted: 1, onDevice: 1, overBudget: 0, limit: 3 });
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox', { name: 'Copper card' }));
    await screen.findByText('1 pass, 1 on a device.');
    const before = counts.length;
    await user.type(screen.getByRole('textbox', { name: 'Search' }), 'sam');
    await screen.findByText('1 pass, 1 on a device.');
    await waitFor(() => expect(counts.length).toBeGreaterThan(before));
    expect(counts.length - before).toBeLessThanOrEqual(2);
  });

  it('schedules for a time and says when it goes out', async () => {
    const { created } = setup('/admin/messages/new?orgId=org1');
    const user = userEvent.setup();
    await writeMessage(user);
    await user.click(screen.getByRole('radio', { name: 'Schedule' }));
    const when = await screen.findByLabelText(/Send at/);
    fireEvent.change(when, { target: { value: '2999-01-01T09:00' } });
    await user.click(screen.getByRole('button', { name: 'Schedule' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Schedule for 1 pass?' });
    expect(within(confirm).getByText(/^Scheduled to start /)).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Schedule' }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toEqual(
      expect.objectContaining({ send: 'schedule', at: expect.any(Number) }),
    );
  });

  it('saves a draft once however often it is pressed', async () => {
    const { created } = setup('/admin/messages/new?orgId=org1');
    const user = userEvent.setup();
    await writeMessage(user);
    const save = screen.getByRole('button', { name: 'Save draft' });
    await user.dblClick(save);
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toEqual(expect.objectContaining({ send: 'draft' }));
  });

  it('composes a change to chosen fields', async () => {
    const { created } = setup('/admin/messages/new?orgId=org1&kind=change');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox', { name: 'Copper card' }));
    await user.click(await screen.findByRole('checkbox', { name: 'Member name' }));
    await user.clear(await screen.findByRole('textbox', { name: /Member name/ }));
    await user.type(screen.getByRole('textbox', { name: /Member name/ }), 'Sam Lee');
    await screen.findByText('1 pass, 1 on a device.');
    await user.click(screen.getByRole('button', { name: 'Send now' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Send change to 1 pass?' });
    await user.click(within(confirm).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toEqual(
      expect.objectContaining({ kind: 'change', patch: { name: 'Sam Lee' } }),
    );
  });

  it('will not send to no passes', async () => {
    const { created } = setup('/admin/messages/new?orgId=org1', {}, () =>
      json({ targeted: 0, onDevice: 0, overBudget: 0, limit: 3 }),
    );
    const user = userEvent.setup();
    await writeMessage(user);
    await user.click(screen.getByRole('button', { name: 'Send now' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'No passes match' });
    expect(within(dialog).queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
    expect(created).toHaveLength(0);
  });

  it('says so when the passes cannot be counted', async () => {
    setup('/admin/messages/new?orgId=org1', {}, () => problem(500, 'server_error', 'Down.'));
    const user = userEvent.setup();
    await writeMessage(user);
    await user.click(screen.getByRole('button', { name: 'Send now' }));
    expect(
      await screen.findByRole('alertdialog', { name: 'Could not count the passes' }),
    ).toBeInTheDocument();
  });

  it('edits a saved draft, replacing it before it sends', async () => {
    const calls: string[] = [];
    const draft = broadcast({
      id: 'b5',
      orgId: 'org1',
      state: 'draft',
      startedAt: null,
      target: { templateIds: ['tpl1'] },
      patch: { message: 'First words' },
    });
    setup('/admin/messages/new?from=b5', {
      '/api/v1/broadcasts/b5': (_u, init) => {
        calls.push(`${init?.method ?? 'GET'} b5 ${String(init?.body ?? '')}`);
        return json(init?.method === 'PATCH' ? { ...draft, patch: { message: 'Second' } } : draft);
      },
      '/api/v1/broadcasts/b5/send': (_u, init) => {
        calls.push(`POST send ${String(init?.body)}`);
        return json({ ...draft, state: 'sending' });
      },
      '/api/v1/broadcasts/b5/items': () => json({ items: [], nextCursor: null }),
    });
    const user = userEvent.setup();
    const field = await screen.findByRole('textbox', { name: 'Message' });
    await waitFor(() => expect(field).toHaveValue('First words'));
    expect(screen.getByRole('heading', { name: 'Edit draft' })).toBeInTheDocument();
    await user.clear(field);
    await user.type(field, 'Second');
    await screen.findByText('1 pass, 1 on a device.');
    await user.click(screen.getByRole('button', { name: 'Send now' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Send to 1 pass?' });
    await user.click(within(confirm).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(calls.some((c) => c.startsWith('POST send'))).toBe(true));
    const patched = calls.find((c) => c.includes('PATCH'));
    expect(patched).toContain('"message":"Second"');
    expect(patched).toContain('"send":"draft"');
  });
});
