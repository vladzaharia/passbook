import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { type FetchHandler, json, renderApp } from '../../lib/test-utils.tsx';
import { slotsFor } from './detail/images-tab.tsx';
import {
  connection,
  ORG,
  passDetail,
  SAMPLE_PASS_JSON,
  templateDetail,
  templateSummary,
} from './test-fixtures.ts';

const method = (init?: RequestInit) => (init?.method ?? 'GET').toUpperCase();

function handlers(
  state: { pass: ReturnType<typeof passDetail> },
  extra: Record<string, FetchHandler> = {},
): Record<string, FetchHandler> {
  return {
    '/api/v1/orgs': () => json({ items: [ORG], nextCursor: null }),
    '/api/v1/templates': () => json({ items: [templateSummary()], nextCursor: null }),
    '/api/v1/templates/tpl1': () => json(templateDetail()),
    '/api/v1/passes/p1': () => json(state.pass),
    '/api/v1/passes/p1/assets': () => json({ items: [] }),
    '/api/v1/delivery': () => json({ items: [] }),
    '/api/v1/connections': () => json({ items: [connection()], nextCursor: null }),
    ...extra,
  };
}

describe('connection tab', () => {
  it('binds an unbound pass to a connection and ref', async () => {
    const user = userEvent.setup();
    const state = { pass: passDetail() };
    const bodies: unknown[] = [];
    await renderApp('/admin/passes/p1?tab=connection', {
      session: 'admin',
      handlers: handlers(state, {
        '/api/v1/passes/p1/connection': (_u, init) => {
          expect(method(init)).toBe('PUT');
          bodies.push(JSON.parse(String(init?.body)));
          state.pass = passDetail({ connectionId: 'c1' });
          return json(state.pass);
        },
        '/api/v1/connections/c1': () => json({ ...connection(), runs: [] }),
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Bind' }));
    expect(await screen.findByText('Choose a connection.')).toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: /Connection/ }));
    await user.click(await screen.findByRole('option', { name: 'MemberSpot sync' }));
    await user.click(screen.getByRole('button', { name: 'Bind' }));
    expect(await screen.findByText('Enter the connection ref.')).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Ref/), 'm-042');
    await user.click(screen.getByRole('checkbox', { name: /take over all fields/ }));
    await user.click(screen.getByRole('button', { name: 'Bind' }));
    await waitFor(() =>
      expect(bodies).toEqual([
        { connectionId: 'c1', externalRef: 'm-042', resetFieldSources: true },
      ]),
    );
  });

  it('unbinds after confirmation', async () => {
    const user = userEvent.setup();
    const state = { pass: passDetail({ connectionId: 'c1' }) };
    const bodies: unknown[] = [];
    await renderApp('/admin/passes/p1?tab=connection', {
      session: 'admin',
      handlers: handlers(state, {
        '/api/v1/connections/c1': () => json({ ...connection(), runs: [] }),
        '/api/v1/passes/p1/connection': (_u, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          state.pass = passDetail();
          return json(state.pass);
        },
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Unbind' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Unbind' }));
    await waitFor(() => expect(bodies).toEqual([{ connectionId: null, externalRef: null }]));
  });
});

describe('delivery and images', () => {
  it('resends with the attachment option', async () => {
    const user = userEvent.setup();
    const state = { pass: passDetail({ holderEmail: 'a@b.co' }) };
    const bodies: unknown[] = [];
    await renderApp('/admin/passes/p1?tab=delivery', {
      session: 'admin',
      handlers: handlers(state, {
        '/api/v1/passes/p1/resend-email': (_u, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return json({ ok: true }, 202);
        },
      }),
    });
    await user.click(await screen.findByRole('checkbox', { name: 'Attach .pkpass' }));
    await user.click(screen.getByRole('button', { name: 'Resend email' }));
    await waitFor(() => expect(bodies).toEqual([{ attach: true }]));
  });

  it('lists the slots the style renders and defaults to the first', () => {
    const poster = {
      preferredStyleSchemes: ['posterGeneric', 'generic'],
      generic: {},
    };
    expect(slotsFor(poster)).toEqual(['artwork', 'primaryLogo', 'secondaryLogo', 'icon', 'logo']);
    expect(slotsFor(SAMPLE_PASS_JSON)).toEqual(['thumbnail', 'icon', 'logo']);
    expect(slotsFor({})).toContain('artwork');
  });

  it('puts Showing in a badge, not a button', async () => {
    const state = { pass: passDetail() };
    await renderApp('/admin/passes/p1?tab=versions', {
      session: 'admin',
      handlers: handlers(state, {
        '/api/v1/passes/p1/diff': () => json({ changes: [] }),
      }),
    });
    expect(await screen.findByText('Showing')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Showing/ })).toBeNull();
  });
});
