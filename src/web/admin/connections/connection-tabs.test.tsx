import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { type FetchHandler, json, renderApp } from '../../lib/test-utils.tsx';
import {
  CONNECTOR,
  connectionDetail,
  ORG,
  templateDetail,
  templateSummary,
} from '../passes/test-fixtures.ts';

const method = (init?: RequestInit) => (init?.method ?? 'GET').toUpperCase();

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

describe('mapping tab', () => {
  it('reads Template ← source = sample once a sample loads, with one header row', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/connections/c1?tab=mapping', {
      session: 'admin',
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
