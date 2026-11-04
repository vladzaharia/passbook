import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { json, renderApp } from '@/web/lib/test-utils.tsx';
import { ORG, templateDetail, templateSummary } from '../passes/test-fixtures.ts';
import { broadcast } from './test-fixtures.ts';

const MESSAGING = templateDetail({
  manifest: { inputs: templateDetail().inputSchema, messaging: { input: 'message' } },
});

describe('Message composer', () => {
  it('sends now and lands on the message', async () => {
    const created: unknown[] = [];
    await renderApp('/admin/messages/new?orgId=org1', {
      session: 'admin',
      handlers: {
        '/api/v1/orgs': () => json({ items: [ORG], nextCursor: null }),
        '/api/v1/templates': () => json({ items: [templateSummary()], nextCursor: null }),
        '/api/v1/templates/tpl1': () => json(MESSAGING),
        '/api/v1/broadcasts/preview': () =>
          json({ targeted: 1, onDevice: 1, overBudget: 0, limit: 3 }),
        '/api/v1/broadcasts': (_u, init) => {
          created.push(JSON.parse(String(init?.body)));
          return json(broadcast({ id: 'b9', orgId: 'org1', state: 'sending' }), 201);
        },
        '/api/v1/broadcasts/b9': () =>
          json(broadcast({ id: 'b9', orgId: 'org1', state: 'sending' })),
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox', { name: 'Copper card' }));
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Doors open at 8.');
    expect(await screen.findByText('1 pass, 1 on a device.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send now' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Send to 1 pass?' });
    await user.click(within(confirm).getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('heading', { name: 'Doors open late' })).toBeInTheDocument();
    expect(created).toEqual([
      expect.objectContaining({ orgId: 'org1', kind: 'message', send: 'now' }),
    ]);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
