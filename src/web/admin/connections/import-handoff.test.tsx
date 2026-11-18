import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { json, membershipFixture, renderApp } from '../../lib/test-utils.tsx';
import { finished, PLAN } from '../passes/import/import-test-fixtures.ts';
import { CONNECTOR, ORG, templateDetail, templateSummary } from '../passes/test-fixtures.ts';
import {
  handOffToConnection,
  rememberImportLink,
  takeConnectionPrefill,
} from './import-handoff.ts';

const LINK = 'https://docs.google.com/spreadsheets/d/e/2PACX-secret/pub?output=csv';
const membership = membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug });
const SHEET = {
  ...CONNECTOR,
  type: 'csv-url',
  displayName: 'CSV sheet link',
  capabilities: { poll: true, delta: false, webhook: false, import: false, snapshot: false },
  configSchema: {
    type: 'object',
    required: ['url', 'idColumn'],
    properties: {
      url: { type: 'string', format: 'uri', 'x-label': 'Sheet link' },
      idColumn: { type: 'string', 'x-label': 'ID column' },
    },
  },
  secretSchema: null,
};

const imp = (over: Record<string, unknown> = {}) =>
  finished({
    source: { kind: 'url', name: 'docs.google.com' },
    plan: {
      mapping: { name: { from: '/Member Name' } },
      holderEmail: { from: '/Email' },
      externalId: { from: '/Id' },
      match: 'externalId',
      keepManual: false,
      save: true,
    },
    ...over,
  }) as never;

beforeEach(() => sessionStorage.clear());

describe('import to connection handoff', () => {
  it('keeps the link in the tab only, hands over the plan once, and never puts the link in the address', () => {
    rememberImportLink('imp1', LINK);
    handOffToConnection(imp());
    expect(sessionStorage.getItem('wallet-import-handoff')).toContain('2PACX-secret');
    const prefill = takeConnectionPrefill();
    expect(prefill).toEqual({
      templateId: 'tpl1',
      url: LINK,
      idColumn: 'Id',
      holderEmailField: '/Email',
      mapping: { name: { from: '/Member Name' } },
    });
    expect(takeConnectionPrefill()).toBeNull();
  });

  it('leaves the link empty when this tab did not start the import, and unescapes the column', () => {
    handOffToConnection(
      imp({ plan: { ...PLAN, externalId: { from: '/a~1b' }, holderEmail: null } }),
    );
    expect(takeConnectionPrefill()).toMatchObject({
      url: '',
      idColumn: 'a/b',
      holderEmailField: '',
    });
  });

  it('hands nothing over for an import without a plan', () => {
    handOffToConnection(imp({ plan: null }));
    expect(takeConnectionPrefill()).toBeNull();
  });

  it('opens the wizard on the sheet connector with the link, column, template and mapping', async () => {
    const user = userEvent.setup();
    rememberImportLink('imp1', LINK);
    handOffToConnection(imp());
    const posts: Record<string, unknown>[] = [];
    const { router } = await renderApp('/admin/connections/new', {
      session: 'admin',
      memberships: [membership],
      selectedOrg: ORG.id,
      handlers: {
        '/api/v1/orgs': () => json({ items: [ORG], nextCursor: null }),
        '/api/v1/connectors': () => json({ items: [SHEET] }),
        '/api/v1/connectors/csv-url': () => json(SHEET),
        '/api/v1/templates': () => json({ items: [templateSummary()], nextCursor: null }),
        '/api/v1/templates/tpl1': () => json(templateDetail()),
        '/api/v1/connections': (_u, init) => {
          if ((init?.method ?? 'GET') === 'POST') {
            posts.push(JSON.parse(String(init?.body)));
            return json({ id: 'c9' }, 201);
          }
          return json({ items: [], nextCursor: null });
        },
      },
    });
    const link = await screen.findByLabelText(/Sheet link/);
    expect(link).toHaveValue(LINK);
    expect(screen.getByLabelText(/ID column/)).toHaveValue('Id');
    expect(screen.getByLabelText(/^Name/)).toHaveValue('Sheet sync');
    expect(router.state.location.search).not.toHaveProperty('url');
    expect(router.state.location.href).not.toContain('2PACX');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    // Mapping step: the import's mapping is already there.
    expect(await screen.findByText('/Member Name')).toBeInTheDocument();
    await waitFor(() => expect(posts).toHaveLength(0));
    // A second visit starts empty.
    expect(takeConnectionPrefill()).toBeNull();
  });
});
