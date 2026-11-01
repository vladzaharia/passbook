import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { json, renderApp } from '../../lib/test-utils.tsx';
import {
  INPUT_SCHEMA,
  ORG,
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
    await user.click(await screen.findByRole('button', { name: /Henry's/ }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('button', { name: /Copper card/ }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByLabelText(/Member name/);

    expect(screen.getByRole('combobox', { name: /Level/ })).toHaveTextContent('Blue');
    await user.click(screen.getByRole('combobox', { name: /Level/ }));
    expect(screen.queryByRole('option', { name: 'None' })).toBeNull();
    await user.keyboard('{Escape}');

    expect(await screen.findByText(/Preview unavailable/)).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 400));
    expect(previewPosts).toEqual([]);

    await user.type(screen.getByLabelText(/Member name/), 'Sam');
    await waitFor(() =>
      expect(previewPosts).toContainEqual({ input: { name: 'Sam', level: 'blue' } }),
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
        '/api/v1/templates/tpl1/preview': previewOk,
        '/api/v1/templates/tpl2/preview': previewOk,
      },
    });
    await user.click(await screen.findByRole('button', { name: /Henry's/ }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
  }

  it('lists the org templates first, then the unassigned ones', async () => {
    await openTemplates([
      templateSummary({ id: 'tpl2', name: 'Plain card', orgId: null, orgName: null }),
      templateSummary(),
    ]);
    const own = await screen.findByRole('heading', { name: "Henry's" });
    const other = screen.getByRole('heading', { name: 'Other templates' });
    const copper = screen.getByRole('button', { name: /Copper card/ });
    const plain = screen.getByRole('button', { name: /Plain card/ });
    expect(own.compareDocumentPosition(copper) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(copper.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(other.compareDocumentPosition(plain) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows one list without headings when the org has none', async () => {
    await openTemplates([
      templateSummary({ id: 'tpl2', name: 'Plain card', orgId: null, orgName: null }),
    ]);
    expect(await screen.findByRole('button', { name: /Plain card/ })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Other templates' })).toBeNull();
    expect(screen.queryByRole('heading', { name: "Henry's" })).toBeNull();
  });
});
