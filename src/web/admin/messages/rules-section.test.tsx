import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { json, membershipFixture, renderApp } from '@/web/lib/test-utils.tsx';
import { ORG, templateDetail, templateSummary } from '../passes/test-fixtures.ts';

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  });
});
afterEach(() => vi.unstubAllGlobals());

const SCHEMA = {
  type: 'object',
  properties: {
    message: { type: 'string', 'x-label': 'Message' },
    expiresOn: { type: 'string', format: 'date', 'x-label': 'Expires on' },
    tier: { type: 'string', enum: ['gold', 'silver'], 'x-order': 3 },
  },
};
const DETAIL = templateDetail({
  inputSchema: SCHEMA,
  manifest: { inputs: SCHEMA, messaging: { input: 'message' } },
});
const RULE = {
  id: 'r1',
  orgId: 'org1',
  mode: 'live',
  name: 'Renewal',
  templateIds: ['tpl1'],
  anchor: { kind: 'input', input: 'expiresOn' },
  offset: { amount: 7, unit: 'day', when: 'before' },
  yearly: false,
  sendAt: '10:00',
  timeZone: 'Europe/London',
  message: 'Your card ends in 7 days.',
  clearAfter: 604_800_000,
  on: true,
  state: 'on',
  pausedCode: null,
  nextCheckAt: null,
  sent: 4,
  skipped: 0,
  createdAt: 1,
  updatedAt: 1,
  version: 2,
};

function setup(items: unknown[] = [RULE]) {
  const saved: { method: string; url: string; body: unknown }[] = [];
  const previews: unknown[] = [];
  const done = renderApp('/admin/messages?orgId=org1', {
    session: 'admin',
    memberships: [membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug })],
    selectedOrg: ORG.id,
    handlers: {
      '/api/v1/orgs': () => json({ items: [ORG], nextCursor: null }),
      '/api/v1/broadcasts': () => json({ items: [], nextCursor: null }),
      '/api/v1/templates': () => json({ items: [templateSummary()], nextCursor: null }),
      '/api/v1/templates/tpl1': () => json(DETAIL),
      '/api/v1/message-rules': (url, init) => {
        if (init?.method === 'POST') {
          saved.push({ method: 'POST', url: url.pathname, body: JSON.parse(String(init.body)) });
          return json({ ...RULE, id: 'r2' }, 201);
        }
        return json({ items, nextCursor: null });
      },
      '/api/v1/message-rules/preview': (_u, init) => {
        previews.push(JSON.parse(String(init?.body)));
        return json({ days: [{ date: '2026-12-03', count: 4 }], total: 4, atLimit: 0 });
      },
      '/api/v1/message-rules/r1': (url, init) => {
        saved.push({
          method: String(init?.method),
          url: url.pathname,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return json({ ...RULE, name: 'Renewal 2', version: 3 });
      },
    },
  });
  return { saved, previews, done };
}

describe('Automatic messages', () => {
  it('creates a rule with a condition and shows who is due', async () => {
    const { saved, previews } = setup([]);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /New/ }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: /Name/ }), 'Renewal');
    await user.click(await within(dialog).findByRole('checkbox', { name: 'Copper card' }));
    await user.click(within(dialog).getByRole('button', { name: /Add condition/ }));
    await user.click(within(dialog).getByRole('combobox', { name: 'Input' }));
    await user.click(await screen.findByRole('option', { name: 'Tier' }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'gold' }));
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    await user.click(await within(dialog).findByRole('combobox', { name: 'Counting from' }));
    await user.click(await screen.findByRole('option', { name: 'Expires on' }));
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    await user.type(
      await within(dialog).findByRole('textbox', { name: /Text/ }),
      'Your card ends soon.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(previews.length).toBeGreaterThan(0));
    expect(previews.at(-1)).toMatchObject({ match: [{ input: 'tier', values: ['gold'] }] });
    expect(await within(dialog).findByText('Next 14 days: 4 passes')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Create message' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]?.body).toMatchObject({
      name: 'Renewal',
      templateIds: ['tpl1'],
      anchor: { kind: 'input', input: 'expiresOn' },
      match: [{ input: 'tier', values: ['gold'] }],
    });
  });

  it('shows what is missing and saves nothing', async () => {
    const { saved } = setup([]);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /New/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    expect(await within(dialog).findByText('Name it.')).toBeInTheDocument();
    expect(within(dialog).getByText('Choose at least one template.')).toBeInTheDocument();
    expect(saved).toHaveLength(0);
  });

  it('edits with the version it read and deletes after a confirm', async () => {
    const { saved } = setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Actions for Renewal' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByRole('textbox', { name: /Name/ });
    await user.clear(name);
    await user.type(name, 'Renewal 2');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saved.some((s) => s.method === 'PUT')).toBe(true));
    expect(saved.find((s) => s.method === 'PUT')?.body).toMatchObject({
      name: 'Renewal 2',
      version: 2,
    });
    await user.click(await screen.findByRole('button', { name: 'Actions for Renewal' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(saved.some((s) => s.method === 'DELETE')).toBe(true));
  });
});
