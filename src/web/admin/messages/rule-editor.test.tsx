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

function setup(refuse?: Response) {
  const saved: unknown[] = [];
  renderApp('/admin/messages?orgId=org1', {
    session: 'admin',
    memberships: [membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug })],
    selectedOrg: ORG.id,
    handlers: {
      '/api/v1/orgs': () => json({ items: [ORG], nextCursor: null }),
      '/api/v1/broadcasts': () => json({ items: [], nextCursor: null }),
      '/api/v1/templates': () => json({ items: [templateSummary()], nextCursor: null }),
      '/api/v1/templates/tpl1': () => json(DETAIL),
      '/api/v1/message-rules': () => json({ items: [RULE], nextCursor: null }),
      '/api/v1/message-rules/preview': () =>
        json({ days: [{ date: '2026-12-03', count: 4 }], total: 4, atLimit: 0 }),
      '/api/v1/message-rules/r1': (_u, init) => {
        saved.push(JSON.parse(String(init?.body)));
        return refuse ?? json({ ...RULE, version: 3 });
      },
    },
  });
  return saved;
}

async function openEditor() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Actions for Renewal' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));
  return { user, dialog: await screen.findByRole('dialog') };
}

describe('Automatic message editor', () => {
  it('saves only after a change and reaches any step from the rail', async () => {
    const saved = setup();
    const { user, dialog } = await openEditor();
    const save = within(dialog).getByRole('button', { name: 'Save' });
    expect(save).toHaveAttribute('aria-disabled', 'true');
    expect(within(dialog).getByText('No changes.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Message' }));
    const text = await within(dialog).findByRole('textbox', { name: /Text/ });
    await user.type(text, ' Bring it.');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toMatchObject({ message: 'Your card ends in 7 days. Bring it.', version: 2 });
  });

  it('shows who is due on the review step', async () => {
    setup();
    const { user, dialog } = await openEditor();
    await user.click(within(dialog).getByRole('button', { name: 'Review' }));
    expect(await within(dialog).findByText('Next 14 days: 4 passes')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Edit message' })).toBeInTheDocument();
  });

  it('takes a refused field back to its step', async () => {
    setup(
      json(
        {
          type: 'about:blank',
          status: 422,
          code: 'validation_failed',
          title: 'Invalid',
          detail: 'Invalid',
          issues: [{ path: 'message', message: 'Too long for a lock screen.' }],
        },
        422,
      ),
    );
    const { user, dialog } = await openEditor();
    await user.click(within(dialog).getByRole('button', { name: 'Review' }));
    const name = within(dialog).getByRole('button', { name: 'Edit passes' });
    await user.click(name);
    await user.type(await within(dialog).findByRole('textbox', { name: /Name/ }), ' 2');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Too long for a lock screen.')).toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: /Text/ })).toBeInTheDocument();
  });
});
