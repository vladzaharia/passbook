import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { type FetchHandler, json, membershipFixture, renderApp } from '../../lib/test-utils.tsx';
import { CONNECTOR, connectionDetail, ORG } from '../passes/test-fixtures.ts';
import { flattenSchema, keepOpaque, opaqueSummary, withoutOpaque } from './config-schema.ts';

const membership = membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug });

const REST = {
  ...CONNECTOR,
  version: 2,
  configSchema: {
    type: 'object',
    required: ['baseUrl'],
    properties: {
      baseUrl: { type: 'string', format: 'uri', 'x-label': 'Base URL' },
      headers: {
        type: 'array',
        'x-label': 'Headers',
        items: {
          type: 'object',
          properties: { name: { type: 'string' }, value: { type: 'string' } },
        },
      },
      list: {
        type: 'object',
        'x-label': 'List endpoint',
        required: ['path'],
        properties: {
          path: { type: 'string', 'x-label': 'List path' },
          query: {
            type: 'array',
            items: { type: 'object', properties: { name: { type: 'string' } } },
          },
          pagination: { anyOf: [{ type: 'object' }, { type: 'object' }] },
          incremental: { type: 'object', properties: { param: { type: 'string' } } },
        },
      },
    },
  },
};

const stored = {
  baseUrl: 'https://api.example.com/v1',
  headers: [{ name: 'Notion-Version', value: '2022-06-28' }],
  list: {
    path: '/members',
    query: [{ name: 'status', value: 'active' }],
    pagination: { style: 'next-link', nextPointer: '/links/next' },
    incremental: {
      param: 'updated_since',
      field: '/updated_at',
      format: 'iso',
      overlapSeconds: 300,
    },
  },
};

describe('configuration of a REST connection', () => {
  it('keeps pagination, parameters, headers and the incremental filter out of the form and through a save', async () => {
    const user = userEvent.setup();
    const patches: Record<string, unknown>[] = [];
    const c = connectionDetail({ config: stored });
    await renderApp('/admin/connections/c1?tab=config', {
      session: 'admin',
      memberships: [membership],
      selectedOrg: ORG.id,
      handlers: {
        '/api/v1/orgs': () => json({ items: [ORG], nextCursor: null }),
        '/api/v1/connectors/http-json': () => json(REST),
        '/api/v1/connections/c1': (_u: URL, init?: RequestInit) => {
          if ((init?.method ?? 'GET').toUpperCase() === 'PATCH') {
            patches.push(JSON.parse(String(init?.body)));
          }
          return json(c);
        },
      } satisfies Record<string, FetchHandler>,
    });
    expect(await screen.findByText('Pagination: next link')).toBeVisible();
    expect(screen.getByText('List parameters: 1')).toBeVisible();
    expect(screen.getByText('Updated since: updated_since')).toBeVisible();
    expect(screen.getByText('Headers: 1')).toBeVisible();
    expect(screen.queryByLabelText('Pagination')).toBeNull();
    expect(screen.queryByLabelText('Headers')).toBeNull();

    const url = screen.getByLabelText(/Base URL/);
    await user.clear(url);
    await user.type(url, 'https://api.example.org/v2');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]?.config).toMatchObject({
      baseUrl: 'https://api.example.org/v2',
      headers: stored.headers,
      list: stored.list,
    });
  });
});

describe('opaque config helpers', () => {
  it('drops the opaque keys from the schema and their requirements', () => {
    const flat = withoutOpaque(flattenSchema(REST.configSchema));
    expect(Object.keys((flat?.properties as object) ?? {})).toEqual(['baseUrl', 'list.path']);
  });

  it('summarises only what is set', () => {
    expect(opaqueSummary({ baseUrl: 'x' })).toEqual([]);
    expect(opaqueSummary({ list: { path: '/l', pagination: { style: 'link-header' } } })).toEqual([
      'Pagination: Link header',
    ]);
  });

  it('puts the stored values back, and does not resurrect a removed list', () => {
    expect(keepOpaque(stored, { baseUrl: 'b', list: { path: '/x' } })).toEqual({
      baseUrl: 'b',
      headers: stored.headers,
      list: {
        path: '/x',
        query: stored.list.query,
        pagination: stored.list.pagination,
        incremental: stored.list.incremental,
      },
    });
    expect(keepOpaque(stored, { baseUrl: 'b' })).toEqual({ baseUrl: 'b', headers: stored.headers });
  });
});
