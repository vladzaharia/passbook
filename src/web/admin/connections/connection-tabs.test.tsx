import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { type FetchHandler, json, membershipFixture, renderApp } from '../../lib/test-utils.tsx';
import {
  CONNECTOR,
  connectionDetail,
  ORG,
  templateDetail,
  templateSummary,
} from '../passes/test-fixtures.ts';

const method = (init?: RequestInit) => (init?.method ?? 'GET').toUpperCase();
const membership = membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug });
const reader = membershipFixture(ORG.id, {
  orgName: ORG.name,
  orgSlug: ORG.slug,
  capabilities: ['integrations:read', 'templates:read'],
});

function handlers(
  state: { c: ReturnType<typeof connectionDetail> },
  patches: Record<string, unknown>[],
  extra: Record<string, FetchHandler> = {},
) {
  return {
    '/api/v1/orgs': () => json({ items: [ORG], nextCursor: null }),
    '/api/v1/templates': () => json({ items: [templateSummary()], nextCursor: null }),
    '/api/v1/templates/tpl1': () => json(templateDetail()),
    '/api/v1/connectors/http-json': () => json(CONNECTOR),
    '/api/v1/connections/c1': (_u: URL, init?: RequestInit) => {
      if (method(init) === 'PATCH') {
        const body = JSON.parse(String(init?.body));
        patches.push(body);
        state.c = { ...state.c, ...body };
      }
      return json(state.c);
    },
    ...extra,
  } satisfies Record<string, FetchHandler>;
}

describe('connection tabs outside the selected organization', () => {
  it.each(['health', 'mapping', 'config', 'settings', 'webhook'])(
    'does not mount %s or fetch its dependent resources',
    async (tab) => {
      const requests: string[] = [];
      const dependent: string[] = [];
      const track = (path: string, body: unknown) => () => {
        dependent.push(path);
        return json(body);
      };
      const foreign = connectionDetail({
        orgId: 'org2',
        name: 'Unselected connection',
        mode: 'hybrid',
        config: { baseUrl: 'https://private.example' },
      });
      await renderApp(`/admin/connections/c1?tab=${tab}`, {
        session: 'admin',
        memberships: [membership],
        selectedOrg: ORG.id,
        handlers: handlers({ c: foreign }, [], {
          '/api/v1/connections/c1': (_url, init) => {
            requests.push(method(init));
            return json(foreign);
          },
          '/api/v1/connectors': track('connectors', { items: [CONNECTOR] }),
          '/api/v1/connectors/http-json': track('connector detail', CONNECTOR),
          '/api/v1/templates': track('templates', { items: [templateSummary()], nextCursor: null }),
          '/api/v1/templates/tpl1': track('template detail', templateDetail()),
        }),
      });

      expect(await screen.findByText('Connection not found')).toBeVisible();
      expect(requests).toContain('GET');
      expect(requests.every((request) => request === 'GET')).toBe(true);
      expect(dependent).toEqual([]);
      expect(screen.queryByText('Unselected connection')).not.toBeInTheDocument();
      expect(screen.queryByText('https://private.example')).not.toBeInTheDocument();
      expect(
        screen.queryByText('https://wallet.example/hooks/connections/c1'),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('tablist', { name: 'Connection sections' }),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Test' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Load sample' })).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/Base URL/)).not.toBeInTheDocument();
    },
  );
});

describe('connection tabs for a read-only member', () => {
  it('shows mapping without allowing edits or loading a sample', async () => {
    const patches: Record<string, unknown>[] = [];
    await renderApp('/admin/connections/c1?tab=mapping', {
      session: 'admin',
      memberships: [reader],
      selectedOrg: ORG.id,
      handlers: handlers({ c: connectionDetail() }, patches),
    });

    expect(await screen.findByRole('list', { name: 'Mappings' })).toBeVisible();
    expect(screen.getByLabelText('Template')).toBeDisabled();
    expect(screen.getByRole('combobox', { name: /^Source field/ })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: /^Template field/ })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: /^Transform/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add mapping' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Auto-map by name' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Load sample' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(patches).toEqual([]);
  });

  it('shows configuration and credential status with editing disabled', async () => {
    const patches: Record<string, unknown>[] = [];
    await renderApp('/admin/connections/c1?tab=config', {
      session: 'admin',
      memberships: [reader],
      selectedOrg: ORG.id,
      handlers: handlers(
        { c: connectionDetail({ config: { baseUrl: 'https://source.example' } }) },
        patches,
      ),
    });

    const url = await screen.findByLabelText(/Base URL/);
    expect(url).toHaveValue('https://source.example');
    expect(url).toBeDisabled();
    expect(screen.getByLabelText('Requests per minute')).toBeDisabled();
    expect(screen.getByLabelText('Max concurrency')).toBeDisabled();
    expect(screen.getByText('Set. Stored encrypted, never shown.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Replace credentials' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(patches).toEqual([]);
  });

  it('shows saved settings with editing disabled', async () => {
    const patches: Record<string, unknown>[] = [];
    await renderApp('/admin/connections/c1?tab=settings', {
      session: 'admin',
      memberships: [reader],
      selectedOrg: ORG.id,
      handlers: handlers({ c: connectionDetail() }, patches),
    });

    const name = await screen.findByLabelText(/^Name/);
    expect(name).toHaveValue('MemberSpot sync');
    expect(name).toBeDisabled();
    expect(screen.getByLabelText('Interval')).toBeDisabled();
    expect(screen.getByLabelText('Holder email')).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Create passes for new records' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(patches).toEqual([]);
  });

  it.each([false, true])(
    'shows the webhook without allowing secret changes (set: %s)',
    async (hasSecret) => {
      const patches: Record<string, unknown>[] = [];
      await renderApp('/admin/connections/c1?tab=webhook', {
        session: 'admin',
        memberships: [reader],
        selectedOrg: ORG.id,
        handlers: handlers(
          { c: connectionDetail({ mode: 'webhook', hasWebhookSecret: hasSecret }) },
          patches,
        ),
      });

      expect(await screen.findByText('https://wallet.example/hooks/connections/c1')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Copy endpoint URL' })).toBeEnabled();
      expect(screen.getByText(hasSecret ? 'Set' : 'Not set')).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Create' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Rotate' })).not.toBeInTheDocument();
      expect(patches).toEqual([]);
    },
  );
});

describe('mapping tab', () => {
  it('does not request template data without template read capability', async () => {
    const requests: string[] = [];
    const { queryClient } = await renderApp('/admin/connections/c1?tab=mapping', {
      session: 'admin',
      memberships: [
        membershipFixture(ORG.id, {
          orgName: ORG.name,
          orgSlug: ORG.slug,
          capabilities: ['integrations:read'],
        }),
      ],
      selectedOrg: ORG.id,
      handlers: handlers({ c: connectionDetail() }, [], {
        '/api/v1/templates': () => {
          requests.push('list');
          return json({ items: [templateSummary()], nextCursor: null });
        },
        '/api/v1/templates/tpl1': () => {
          requests.push('detail');
          return json(templateDetail());
        },
      }),
    });

    expect(await screen.findByRole('list', { name: 'Mappings' })).toBeVisible();
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(screen.getByLabelText('Template')).toBeDisabled();
    expect(screen.getByRole('listitem', { name: 'name ← name' })).toBeVisible();
    expect(requests).toEqual([]);
  });

  it('loads shared template fields in the connection organization', async () => {
    const scopes: (string | null)[] = [];
    await renderApp('/admin/connections/c1?tab=mapping', {
      session: 'user',
      memberships: [
        membershipFixture('org2', {
          orgName: 'Second',
          orgSlug: 'second',
          roles: ['integration_admin'],
          capabilities: ['org:read', 'integrations:read', 'integrations:manage', 'templates:read'],
        }),
      ],
      selectedOrg: 'org2',
      handlers: handlers({ c: connectionDetail({ orgId: 'org2' }) }, [], {
        '/api/v1/templates': () =>
          json({ items: [templateSummary({ orgId: null, orgName: null })], nextCursor: null }),
        '/api/v1/templates/tpl1': (url) => {
          scopes.push(url.searchParams.get('orgId'));
          return json(templateDetail({ orgId: null, orgName: null }));
        },
      }),
    });

    expect(await screen.findByRole('listitem', { name: 'Member name ← name' })).toBeVisible();
    expect(scopes).toContain('org2');
    expect(scopes.every((scope) => scope === 'org2')).toBe(true);
  });

  it('does not use mapping fields from a different organization', async () => {
    const scopes: (string | null)[] = [];
    const { queryClient } = await renderApp('/admin/connections/c1?tab=mapping', {
      session: 'admin',
      memberships: [membershipFixture('org2', { orgName: 'Second', orgSlug: 'second' })],
      selectedOrg: 'org2',
      handlers: handlers({ c: connectionDetail({ orgId: 'org2' }) }, [], {
        '/api/v1/templates': () =>
          json({ items: [templateSummary({ orgId: null, orgName: null })], nextCursor: null }),
        '/api/v1/templates/tpl1': (url) => {
          scopes.push(url.searchParams.get('orgId'));
          return json(
            templateDetail({
              orgId: ORG.id,
              name: 'Private source template',
              inputSchema: {
                type: 'object',
                properties: { name: { type: 'string', 'x-label': 'Private field' } },
              },
            }),
          );
        },
      }),
    });

    await waitFor(() => expect(scopes).toContain('org2'));
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(screen.getByRole('listitem', { name: 'name ← name' })).toBeVisible();
    expect(screen.queryByText('Private field')).not.toBeInTheDocument();
    expect(screen.queryByText('Private source template')).not.toBeInTheDocument();
  });

  it('reads Template ← source = sample once a sample loads, with one header row', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/connections/c1?tab=mapping', {
      session: 'admin',
      memberships: [membership],
      selectedOrg: ORG.id,
      handlers: handlers({ c: connectionDetail() }, [], {
        '/api/v1/connections/c1/test': () =>
          json({
            ok: true,
            durationMs: 5,
            sample: [
              { pointer: '/member/name', preview: '  Maya Chen ' },
              { pointer: '/tier', preview: 'blue' },
            ],
          }),
      }),
    });
    await screen.findByRole('list', { name: 'Mappings' });
    // One header row; per-row captions show only when the row stacks.
    const headers = screen.getAllByText('Source field').filter((el) => !el.closest('li'));
    expect(headers).toHaveLength(1);
    expect(document.querySelector('fieldset legend')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Load sample' }));
    expect(
      await screen.findByRole('listitem', { name: 'Member name ← name = "Maya Chen"' }),
    ).toBeInTheDocument();
  });

  it('auto-maps by name, warns about required fields and saves', async () => {
    const user = userEvent.setup();
    const patches: Record<string, unknown>[] = [];
    await renderApp('/admin/connections/c1?tab=mapping', {
      session: 'admin',
      memberships: [membership],
      selectedOrg: ORG.id,
      handlers: handlers({ c: connectionDetail({ mapping: {} }) }, patches, {
        '/api/v1/connections/c1/test': () =>
          json({
            ok: true,
            durationMs: 5,
            sample: [
              { pointer: '/memberName', preview: 'Maya Chen' },
              { pointer: '/level', preview: 'blue' },
            ],
          }),
      }),
    });
    expect(await screen.findByText('No mappings')).toBeInTheDocument();
    expect(await screen.findByText('Required fields without a source')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load sample' }));
    const auto = screen.getByRole('button', { name: 'Auto-map by name' });
    await waitFor(() => expect(auto).toBeEnabled());
    await user.click(auto);
    expect(screen.queryByText('Required fields without a source')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({
      mapping: { name: { from: '/memberName' }, level: { from: '/level' } },
    });
  });

  it('blocks a row without a template field', async () => {
    const user = userEvent.setup();
    const patches: Record<string, unknown>[] = [];
    await renderApp('/admin/connections/c1?tab=mapping', {
      session: 'admin',
      memberships: [membership],
      selectedOrg: ORG.id,
      handlers: handlers({ c: connectionDetail() }, patches),
    });
    await screen.findByRole('list', { name: 'Mappings' });
    await user.click(screen.getByRole('button', { name: 'Add mapping' }));
    const rows = within(screen.getByRole('list', { name: 'Mappings' })).getAllByRole('listitem');
    await user.click(
      within(rows[1] as HTMLElement).getByRole('combobox', { name: /Source field/ }),
    );
    await user.click(await screen.findByRole('option', { name: '/email' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Choose a template input.')).toBeInTheDocument();
    expect(patches).toHaveLength(0);
  });
});

describe('configuration tab', () => {
  it('edits config, credentials and limits without sending untouched fields', async () => {
    const user = userEvent.setup();
    const patches: Record<string, unknown>[] = [];
    const state = { c: connectionDetail({ config: { baseUrl: 'https://old.example' } }) };
    await renderApp('/admin/connections/c1?tab=config', {
      session: 'admin',
      memberships: [membership],
      selectedOrg: ORG.id,
      handlers: handlers(state, patches),
    });
    const url = await screen.findByLabelText(/Base URL/);
    expect(url).toHaveValue('https://old.example');
    expect(screen.queryByLabelText(/Bearer token/)).not.toBeInTheDocument();
    await user.clear(url);
    await user.type(url, 'https://new.example');
    await user.click(screen.getByRole('button', { name: 'Replace credentials' }));
    await user.type(await screen.findByLabelText(/Bearer token/), 'tok-123');
    await user.type(screen.getByLabelText('Requests per minute'), '120');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({
      config: { baseUrl: 'https://new.example' },
      secrets: { token: 'tok-123' },
      requestsPerMinute: 120,
    });
  });
});
