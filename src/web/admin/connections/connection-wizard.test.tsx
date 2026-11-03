import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
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

const HTTP = {
  ...CONNECTOR,
  description: 'Fetch records from a JSON API.',
  configSchema: {
    type: 'object',
    required: ['baseUrl'],
    properties: {
      baseUrl: { type: 'string', format: 'uri', 'x-label': 'Base URL', 'x-help': 'HTTPS.' },
      recordPath: { type: 'string', 'x-label': 'Record path', default: '/{ref}' },
      auth: {
        type: 'object',
        'x-label': 'Authentication',
        default: { type: 'none' },
        properties: {
          type: {
            type: 'string',
            enum: ['none', 'bearer', 'basic', 'header'],
            default: 'none',
            'x-enumLabels': {
              none: 'None',
              bearer: 'Bearer token',
              basic: 'Basic',
              header: 'Header',
            },
          },
          headerName: { type: 'string', 'x-label': 'Header name', 'x-auth': ['header'] },
        },
      },
    },
  },
  secretSchema: {
    type: 'object',
    properties: {
      token: { type: 'string', 'x-label': 'Token', 'x-auth': ['bearer'] },
      username: { type: 'string', 'x-label': 'Username', 'x-auth': ['basic'] },
    },
  },
};
const WEBHOOK = {
  ...CONNECTOR,
  type: 'webhook-push',
  displayName: 'Webhook push',
  description: 'Your system sends signed records.',
  capabilities: { poll: false, delta: false, webhook: true, import: false, snapshot: false },
  configSchema: { type: 'object', properties: {} },
  secretSchema: null,
};

function wizard(posts: Record<string, unknown>[], failWith?: Response) {
  return {
    '/api/v1/orgs': () => json({ items: [ORG], nextCursor: null }),
    '/api/v1/connectors': () => json({ items: [HTTP, WEBHOOK] }),
    '/api/v1/connectors/http-json': () => json(HTTP),
    '/api/v1/connectors/webhook-push': () => json(WEBHOOK),
    '/api/v1/templates': () => json({ items: [templateSummary()], nextCursor: null }),
    '/api/v1/templates/tpl1': () => json(templateDetail()),
    '/api/v1/connections/test-config': () =>
      json({ ok: true, durationMs: 9, sample: [{ pointer: '/member/name', preview: 'Maya' }] }),
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

type User = ReturnType<typeof userEvent.setup>;
const next = (user: User) => user.click(screen.getByRole('button', { name: /^(Next|Create)$/ }));

async function toConfig(user: User, connector = /HTTP JSON/) {
  await user.click(await screen.findByRole('combobox', { name: 'Organization' }));
  await user.click(await screen.findByRole('option', { name: "Henry's" }));
  await user.click(await screen.findByRole('radio', { name: connector }));
  await next(user);
}

describe('create connection wizard', () => {
  it('shows labelled config with only the chosen auth fields, tests, maps and creates', async () => {
    const user = userEvent.setup();
    const posts: Record<string, unknown>[] = [];
    const { router } = await renderApp('/admin/connections/new', {
      session: 'admin',
      handlers: wizard(posts),
    });
    expect(await screen.findByText('Fetch records from a JSON API.')).toBeInTheDocument();
    expect(screen.queryByText('http-json')).toBeNull();
    await toConfig(user);
    expect(await screen.findByLabelText(/Base URL/)).toBeInTheDocument();
    expect(screen.getByText('HTTPS.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Token')).toBeNull();
    await user.click(screen.getByRole('radio', { name: 'Bearer token' }));
    expect(screen.getByLabelText('Token')).toHaveAttribute('type', 'password');
    expect(screen.queryByLabelText('Username')).toBeNull();
    expect(screen.queryByLabelText('Header name')).toBeNull();
    await user.type(screen.getByLabelText(/^Name/), 'Upstream');
    await user.type(screen.getByLabelText(/Base URL/), 'https://api.example.com');
    await user.type(screen.getByLabelText('Token'), 'sekret');
    await user.click(screen.getByRole('button', { name: 'Test' }));
    expect(await screen.findByText('Test passed')).toBeInTheDocument();
    expect(
      within(screen.getByRole('list', { name: 'Fields in the first record' })).getByText(
        '/member/name',
      ),
    ).toBeInTheDocument();
    await next(user);
    // Mapping: the template is chosen here.
    await user.click(screen.getByRole('combobox', { name: 'Template' }));
    await user.click(await screen.findByRole('option', { name: 'Copper card' }));
    await user.click(await screen.findByRole('button', { name: 'Auto-map by name' }));
    await next(user);
    // Lifecycle: no template select; interval in minutes for poll.
    expect(screen.queryByRole('combobox', { name: /Template/ })).toBeNull();
    expect(await screen.findByLabelText('Interval')).toHaveAttribute('placeholder', '60');
    await next(user);
    expect(screen.getByText('Copper card')).toBeInTheDocument();
    await next(user);
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/connections/c9'));
    expect(posts[0]).toMatchObject({
      orgId: 'org1',
      connectorType: 'http-json',
      name: 'Upstream',
      config: { baseUrl: 'https://api.example.com', auth: { type: 'bearer' } },
      secrets: { token: 'sekret' },
      mapping: { name: { from: '/member/name' } },
      defaultTemplateId: 'tpl1',
      mode: 'poll',
      autoCreate: false,
    });
    expect(posts[0]).not.toHaveProperty('webhookSecret');
  });

  it('blocks the configuration step until the form is valid', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/connections/new', { session: 'admin', handlers: wizard([]) });
    await toConfig(user);
    await user.type(await screen.findByLabelText(/Base URL/), 'not a url');
    await next(user);
    expect(await screen.findByText('Enter a valid URL.')).toBeInTheDocument();
    expect(screen.getAllByText('Required.').length).toBeGreaterThanOrEqual(1);
  });

  it('webhook: no interval; 0 mappings warn and block Create while auto-create is on', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/connections/new', { session: 'admin', handlers: wizard([]) });
    await toConfig(user, /Webhook push/);
    await user.type(await screen.findByLabelText(/^Name/), 'Hooked');
    await next(user);
    await next(user);
    expect(await screen.findByRole('radio', { name: /Webhook/ })).toBeChecked();
    expect(screen.queryByLabelText('Interval')).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: 'Create passes for new records' }));
    await next(user);
    expect(await screen.findByText('Choose a template on Mapping to create passes.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(await screen.findByRole('combobox', { name: 'Template' }));
    await user.click(await screen.findByRole('option', { name: 'Copper card' }));
    await next(user);
    await next(user);
    expect(await screen.findByText('No mappings')).toBeInTheDocument();
    expect(screen.getByText(/Passes cannot be created without mappings/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  });

  it('shows the endpoint and secret once, gated by I saved the secret', async () => {
    const user = userEvent.setup();
    const posts: Record<string, unknown>[] = [];
    const { router } = await renderApp('/admin/connections/new', {
      session: 'admin',
      handlers: wizard(posts),
    });
    const entries = router.history.length;
    await toConfig(user, /Webhook push/);
    await user.type(await screen.findByLabelText(/^Name/), 'Hooked');
    for (let i = 0; i < 4; i++) await next(user);
    expect(await screen.findByText('Endpoint URL')).toBeInTheDocument();
    expect(screen.getByText('Signing secret')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy endpoint URL' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy signing secret' })).toBeInTheDocument();
    expect(posts[0]?.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    const done = screen.getByRole('button', { name: 'Done' });
    expect(done).toBeDisabled();
    await user.click(screen.getByText('Example request'));
    expect(screen.getByText(/x-wallet-signature/)).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'I saved the secret' }));
    await user.click(done);
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/connections/c9'));
    // The connection's page replaces the wizard and leads with its next steps.
    expect(router.history.length).toBe(entries);
    expect(await screen.findByText('Connection created')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Connection created')).toBeNull();
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
    await user.type(await screen.findByLabelText(/^Name/), 'Upstream');
    await user.type(screen.getByLabelText(/Base URL/), 'https://10.0.0.1');
    for (let i = 0; i < 4; i++) await next(user);
    expect(
      await screen.findByText('Fix the highlighted fields on Configuration.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit source' }));
    expect(await screen.findByText('Host is not allowed.')).toBeInTheDocument();
  });
});
