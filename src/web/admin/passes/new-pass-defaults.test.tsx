import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { json, renderApp } from '../../lib/test-utils.tsx';
import {
  INPUT_SCHEMA,
  ORG,
  previewsHandler,
  SAMPLE_PASS_JSON,
  templateDetail,
  templateSummary,
} from './test-fixtures.ts';

const method = (init?: RequestInit) => (init?.method ?? 'GET').toUpperCase();

describe('new pass details step', () => {
  it('seeds schema defaults and skips previews while the input is invalid', async () => {
    const user = userEvent.setup();
    const previewPosts: unknown[] = [];
    const schema = {
      ...INPUT_SCHEMA,
      properties: {
        ...INPUT_SCHEMA.properties,
        level: { ...INPUT_SCHEMA.properties.level, default: 'blue' },
      },
    };
    await renderApp('/admin/passes/new', {
      session: 'admin',
      handlers: {
        '/api/v1/orgs': () => json({ items: [ORG], nextCursor: null }),
        '/api/v1/templates': () => json({ items: [templateSummary()], nextCursor: null }),
        '/api/v1/templates/tpl1': () => json(templateDetail({ inputSchema: schema })),
        '/api/v1/templates/previews': previewsHandler,
        '/api/v1/templates/tpl1/preview': (_u, init) => {
          if (method(init) === 'POST') {
            const body = JSON.parse(String(init?.body)) as { input?: unknown };
            if (body.input) previewPosts.push(body);
          }
          return json({
            passJson: SAMPLE_PASS_JSON,
            warnings: [],
            assetBaseUrl: '/a',
            assetNames: [],
          });
        },
        '/api/v1/connections': () => json({ items: [], nextCursor: null }),
      },
    });
    // One org: the wizard opens on Template.
    await user.click(await screen.findByRole('radio', { name: /Copper card/ }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByLabelText(/Member name/);

    expect(screen.getByRole('combobox', { name: /Level/ })).toHaveTextContent('Blue');
    await user.click(screen.getByRole('combobox', { name: /Level/ }));
    expect(screen.queryByRole('option', { name: 'None' })).toBeNull();
    await user.keyboard('{Escape}');

    // The card shows from the first frame: empty required fields borrow the sample.
    await waitFor(() =>
      expect(previewPosts).toContainEqual({ input: { name: 'Sam', level: 'blue' }, orgId: 'org1' }),
    );
    await user.type(screen.getByLabelText(/Member name/), 'Ann');
    await waitFor(() =>
      expect(previewPosts).toContainEqual({ input: { name: 'Ann', level: 'blue' }, orgId: 'org1' }),
    );
  });
});

describe('new pass template step', () => {
  async function openTemplates(items: unknown[]) {
    const user = userEvent.setup();
    const previewOk = () =>
      json({ passJson: SAMPLE_PASS_JSON, warnings: [], assetBaseUrl: '/a', assetNames: [] });
    await renderApp('/admin/passes/new', {
      session: 'admin',
      handlers: {
        '/api/v1/orgs': () => json({ items: [ORG], nextCursor: null }),
        '/api/v1/templates': () => json({ items, nextCursor: null }),
        '/api/v1/templates/previews': previewsHandler,
        '/api/v1/templates/tpl1/preview': previewOk,
        '/api/v1/templates/tpl2/preview': previewOk,
        '/api/v1/templates/tpl1': () => json(templateDetail()),
      },
    });
    return user;
  }

  it('marks templates every org can use as Shared', async () => {
    await openTemplates([
      templateSummary({ id: 'tpl2', name: 'Plain card', orgId: null, orgName: null }),
      templateSummary(),
    ]);
    const plain = await screen.findByRole('radio', { name: /Plain card/ });
    expect(plain.closest('label')).toHaveTextContent('Shared');
    expect(
      screen.getByRole('radio', { name: /Copper card/ }).closest('label'),
    ).not.toHaveTextContent('Shared');
  });

  it('advances on Enter from a focused template', async () => {
    const user = await openTemplates([templateSummary()]);
    const tile = await screen.findByRole('radio', { name: /Copper card/ });
    tile.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { name: 'Details' })).toBeInTheDocument();
  });
});
