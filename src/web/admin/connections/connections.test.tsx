import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { type FetchHandler, json, problem, renderApp } from '../../lib/test-utils.tsx';
import {
  CONNECTOR,
  connection,
  connectionDetail,
  ORG,
  templateDetail,
  templateSummary,
} from '../passes/test-fixtures.ts';

const method = (init?: RequestInit) => (init?.method ?? 'GET').toUpperCase();
const orgs = () => json({ items: [ORG], nextCursor: null });

function detailHandlers(
  state: { c: ReturnType<typeof connectionDetail> },
  extra: Record<string, FetchHandler> = {},
): Record<string, FetchHandler> {
  return {
    '/api/v1/orgs': orgs,
    '/api/v1/templates': () => json({ items: [templateSummary()], nextCursor: null }),
    '/api/v1/templates/tpl1': () => json(templateDetail()),
    '/api/v1/connectors/http-json': () => json(CONNECTOR),
    '/api/v1/connections/c1': (_u, init) => {
      if (method(init) === 'PATCH') {
        state.c = { ...state.c, ...JSON.parse(String(init?.body)) };
      }
      return json(state.c);
    },
    ...extra,
  };
}

describe('connections list', () => {
  it('shows health pills, error codes and the health filter', async () => {
    const seen: URL[] = [];
    await renderApp('/admin/connections?health=failing', {
      session: 'admin',
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/connections': (url) => {
          seen.push(url);
          return json({
            items: [
              connection(),
              connection({
                id: 'c2',
                name: 'Off',
                enabled: false,
                health: 'healthy',
                lastErrorCode: null,
              }),
            ],
            nextCursor: null,
          });
        },
      },
    });
    expect(await screen.findByRole('link', { name: 'MemberSpot sync' })).toHaveAttribute(
      'href',
      '/admin/connections/c1',
    );
    expect(screen.getByText('Degraded')).toBeInTheDocument();
    expect(screen.getByText('UPSTREAM_5XX')).toBeInTheDocument();
    // A disabled connection reads Disabled whatever its last health was.
    expect(screen.getByText('Disabled')).toBeInTheDocument();
    expect(seen[0]?.searchParams.get('health')).toBe('failing');
  });

  it('shows an empty state with a create action', async () => {
    await renderApp('/admin/connections', {
      session: 'admin',
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/connections': () => json({ items: [], nextCursor: null }),
      },
    });
    expect(await screen.findByText('No connections')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = await renderApp('/admin/connections', {
      session: 'admin',
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/connections': () => json({ items: [connection()], nextCursor: null }),
      },
    });
    await screen.findByRole('link', { name: 'MemberSpot sync' });
    expect((await axe(container)).violations).toEqual([]);
  });
});

describe('connection detail', () => {
  it('shows health, metrics and the last runs with codes and HTTP status', async () => {
    const state = { c: connectionDetail() };
    await renderApp('/admin/connections/c1', { session: 'admin', handlers: detailHandlers(state) });
    expect(await screen.findByText('Failures in a row')).toBeInTheDocument();
    expect(screen.getByText('400 ms / 900 ms')).toBeInTheDocument();
    expect(screen.getByText('25.0%')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Connection runs' });
    expect(within(table).getByText('503')).toBeInTheDocument();
    expect(within(table).getAllByText('UPSTREAM_5XX').length).toBe(1);
    expect(within(table).getByText('10 seen, 2 changed')).toBeInTheDocument();
  });

  it('reports a passing and a failing test', async () => {
    const user = userEvent.setup();
    const state = { c: connectionDetail() };
    let ok = true;
    await renderApp('/admin/connections/c1', {
      session: 'admin',
      handlers: detailHandlers(state, {
        '/api/v1/connections/c1/test': () =>
          ok
            ? json({ ok: true, durationMs: 120 })
            : json({
                ok: false,
                errorCode: 'AUTH_FAILED',
                detail: 'Token rejected.',
                durationMs: 90,
              }),
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Test' }));
    expect(await screen.findByText('Test passed in 120 ms.')).toBeInTheDocument();
    ok = false;
    await user.click(screen.getByRole('button', { name: 'Test' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Test failed (AUTH_FAILED). Token rejected.',
    );
  });

  it('starts a sync and toggles enabled', async () => {
    const user = userEvent.setup();
    const state = { c: connectionDetail() };
    const calls: string[] = [];
    await renderApp('/admin/connections/c1', {
      session: 'admin',
      handlers: detailHandlers(state, {
        '/api/v1/connections/c1/sync': () => {
          calls.push('sync');
          return json({ runId: 'r9', workflowInstanceId: 'w9' }, 202);
        },
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Sync now' }));
    await waitFor(() => expect(calls).toEqual(['sync']));
    await user.click(screen.getByRole('button', { name: 'Disable' }));
    expect(await screen.findByRole('button', { name: 'Enable' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeDisabled();
  });

  it('edits and saves the mapping, and blocks an invalid row', async () => {
    const user = userEvent.setup();
    const state = { c: connectionDetail() };
    const patches: unknown[] = [];
    await renderApp('/admin/connections/c1', {
      session: 'admin',
      handlers: detailHandlers(state, {
        '/api/v1/connections/c1': (_u, init) => {
          if (method(init) === 'PATCH') {
            const body = JSON.parse(String(init?.body));
            patches.push(body);
            state.c = { ...state.c, ...body };
          }
          return json(state.c);
        },
      }),
    });
    await user.click(await screen.findByRole('tab', { name: 'Mapping' }));
    expect(await screen.findByDisplayValue('/member/name')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add mapping' }));
    const pointers = screen.getAllByLabelText('Upstream pointer');
    await user.type(pointers[1] as HTMLElement, '/tier');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Choose a template input.')).toBeInTheDocument();
    expect(patches).toHaveLength(0);

    await user.type(screen.getAllByLabelText('Template input')[1] as HTMLElement, 'level');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({
      mapping: {
        name: { from: '/member/name', transform: { kind: 'trim' } },
        level: { from: '/tier' },
      },
    });
  });

  it('keeps unsaved mapping edits across a background refetch', async () => {
    const user = userEvent.setup();
    const state = { c: connectionDetail() };
    const { queryClient } = await renderApp('/admin/connections/c1', {
      session: 'admin',
      handlers: detailHandlers(state),
    });
    await user.click(await screen.findByRole('tab', { name: 'Mapping' }));
    const pointer = await screen.findByDisplayValue('/member/name');
    await user.type(pointer, 'x');
    await queryClient.invalidateQueries({ queryKey: ['admin', 'connections'] });
    expect(screen.getByDisplayValue('/member/namex')).toBeInTheDocument();
  });

  it('saves lifecycle settings and validates auto create needs a template', async () => {
    const user = userEvent.setup();
    const state = { c: connectionDetail() };
    const patches: Record<string, unknown>[] = [];
    await renderApp('/admin/connections/c1', {
      session: 'admin',
      handlers: detailHandlers(state, {
        '/api/v1/connections/c1': (_u, init) => {
          if (method(init) === 'PATCH') {
            const body = JSON.parse(String(init?.body));
            patches.push(body);
            state.c = { ...state.c, ...body };
          }
          return json(state.c);
        },
      }),
    });
    await user.click(await screen.findByRole('tab', { name: 'Settings' }));
    const interval = await screen.findByLabelText('Interval (seconds)');
    await user.clear(interval);
    await user.type(interval, '30');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/at least 60 seconds/)).toBeInTheDocument();
    expect(patches).toHaveLength(0);
    await user.clear(interval);
    await user.type(interval, '600');
    await user.click(screen.getByRole('switch', { name: 'Create passes for new records' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toMatchObject({
      intervalSeconds: 600,
      autoCreate: true,
      autoEmail: false,
      onMissing: 'flag',
      defaultTemplateId: 'tpl1',
    });
  });

  it('rotates the webhook secret and shows it once', async () => {
    const user = userEvent.setup();
    const state = { c: connectionDetail({ mode: 'webhook' }) };
    const patches: Record<string, unknown>[] = [];
    await renderApp('/admin/connections/c1', {
      session: 'admin',
      handlers: detailHandlers(state, {
        '/api/v1/connections/c1': (_u, init) => {
          if (method(init) === 'PATCH') {
            const body = JSON.parse(String(init?.body));
            patches.push(body);
            state.c = { ...state.c, hasWebhookSecret: true };
          }
          return json(state.c);
        },
      }),
    });
    await user.click(await screen.findByRole('tab', { name: 'Webhook' }));
    expect(
      await screen.findByText('https://wallet.example/hooks/connections/c1'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create secret' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    const region = await screen.findByRole('region', { name: 'Webhook secret' });
    const secret = region.textContent ?? '';
    expect(secret).toMatch(/[0-9a-f]{64}/);
    expect(patches[0]?.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(screen.getByText(/not shown again/i)).toBeInTheDocument();
  });

  it('needs the name typed before deleting', async () => {
    const user = userEvent.setup();
    const state = { c: connectionDetail() };
    const calls: string[] = [];
    const { router } = await renderApp('/admin/connections/c1', {
      session: 'admin',
      handlers: detailHandlers(state, {
        '/api/v1/connections/c1': (_u, init) => {
          if (method(init) === 'DELETE') {
            calls.push('DELETE');
            return json({ ok: true });
          }
          return json(state.c);
        },
        '/api/v1/connections': () => json({ items: [], nextCursor: null }),
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Delete connection' });
    expect(confirm).toBeDisabled();
    await user.type(
      within(dialog).getByLabelText('Type MemberSpot sync to confirm'),
      'MemberSpot sync',
    );
    await user.click(confirm);
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/connections'));
    expect(calls).toEqual(['DELETE']);
  });

  it('shows an error state when the connection is missing', async () => {
    await renderApp('/admin/connections/c1', {
      session: 'admin',
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/connections/c1': () => problem(404, 'not_found', 'Connection not found.'),
      },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection not found.');
  });

  it('has no axe violations', async () => {
    const { container } = await renderApp('/admin/connections/c1', {
      session: 'admin',
      handlers: detailHandlers({ c: connectionDetail() }),
    });
    await screen.findByText('Failures in a row');
    expect((await axe(container)).violations).toEqual([]);
  });
});

describe('create connection wizard', () => {
  function wizard(posts: Record<string, unknown>[], failWith?: Response) {
    return {
      '/api/v1/orgs': orgs,
      '/api/v1/connectors': () => json({ items: [CONNECTOR] }),
      '/api/v1/connectors/http-json': () => json(CONNECTOR),
      '/api/v1/templates': () => json({ items: [templateSummary()], nextCursor: null }),
      '/api/v1/templates/tpl1': () => json(templateDetail()),
      '/api/v1/connections': (_u: URL, init?: RequestInit) => {
        if (method(init) === 'POST') {
          posts.push(JSON.parse(String(init?.body)));
          return (
            failWith ??
            json(
              connection({ id: 'c9', webhookUrl: 'https://wallet.example/hooks/connections/c9' }),
              201,
            )
          );
        }
        return json({ items: [], nextCursor: null });
      },
      '/api/v1/connections/c9': () => json(connectionDetail({ id: 'c9' })),
    } satisfies Record<string, FetchHandler>;
  }

  async function toConfig(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('combobox', { name: 'Organization' }));
    await user.click(await screen.findByRole('option', { name: "Henry's" }));
    await user.click(await screen.findByRole('radio', { name: /HTTP JSON/ }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByLabelText(/Base URL/);
  }

  it('builds the form from the connector schemas and creates the connection', async () => {
    const user = userEvent.setup();
    const posts: Record<string, unknown>[] = [];
    const { router } = await renderApp('/admin/connections/new', {
      session: 'admin',
      handlers: wizard(posts),
    });
    expect(await screen.findByRole('button', { name: 'Next' })).toBeDisabled();
    await toConfig(user);
    // Secrets render as password inputs.
    expect(screen.getByLabelText(/Bearer token/)).toHaveAttribute('type', 'password');
    await user.type(screen.getByLabelText(/^Name/), 'Upstream');
    await user.type(screen.getByLabelText(/Base URL/), 'https://api.example.com');
    await user.type(screen.getByLabelText(/Bearer token/), 'sekret');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    // Mapping step.
    await user.click(screen.getByRole('button', { name: 'Add mapping' }));
    await user.type(screen.getByLabelText('Template input'), 'name');
    await user.type(screen.getByLabelText('Upstream pointer'), '/name');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    // Lifecycle step keeps the connector defaults.
    expect((await screen.findByLabelText('Interval (seconds)')) as HTMLInputElement).toHaveValue(
      3600,
    );
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Create connection' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/connections/c9'));
    expect(posts[0]).toMatchObject({
      orgId: 'org1',
      connectorType: 'http-json',
      name: 'Upstream',
      config: { baseUrl: 'https://api.example.com' },
      secrets: { token: 'sekret' },
      mapping: { name: { from: '/name' } },
      mode: 'poll',
      intervalSeconds: 3600,
      autoCreate: false,
      autoEmail: false,
    });
    expect(posts[0]).not.toHaveProperty('webhookSecret');
  });

  it('blocks the configuration step until the form is valid', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/connections/new', { session: 'admin', handlers: wizard([]) });
    await toConfig(user);
    await user.type(screen.getByLabelText(/Base URL/), 'not a url');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Enter a valid URL.')).toBeInTheDocument();
    expect(screen.getAllByText('Required.').length).toBeGreaterThanOrEqual(2);
  });

  it('shows a generated webhook secret once for webhook mode', async () => {
    const user = userEvent.setup();
    const posts: Record<string, unknown>[] = [];
    await renderApp('/admin/connections/new', { session: 'admin', handlers: wizard(posts) });
    await toConfig(user);
    await user.type(screen.getByLabelText(/^Name/), 'Hooked');
    await user.type(screen.getByLabelText(/Base URL/), 'https://api.example.com');
    await user.type(screen.getByLabelText(/Bearer token/), 'sekret');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('combobox', { name: 'Mode' }));
    await user.click(await screen.findByRole('option', { name: 'Webhook' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Create connection' }));
    const region = await screen.findByRole('region', { name: 'Webhook secret' });
    expect(region.textContent).toMatch(/[0-9a-f]{64}/);
    expect(posts[0]?.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(screen.getByRole('link', { name: 'Open connection' })).toHaveAttribute(
      'href',
      '/admin/connections/c9',
    );
  });

  it('maps server field errors back to the configuration form', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/connections/new', {
      session: 'admin',
      handlers: wizard(
        [],
        problem(422, 'VALIDATION', 'Invalid.', [
          { path: 'config.baseUrl', message: 'Host is not allowed.' },
        ]),
      ),
    });
    await toConfig(user);
    await user.type(screen.getByLabelText(/^Name/), 'Upstream');
    await user.type(screen.getByLabelText(/Base URL/), 'https://10.0.0.1');
    await user.type(screen.getByLabelText(/Bearer token/), 'sekret');
    for (let i = 0; i < 3; i++) await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Create connection' }));
    expect(
      await screen.findByText('Fix the highlighted fields on Configuration.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByText('Host is not allowed.')).toBeInTheDocument();
  });
});
