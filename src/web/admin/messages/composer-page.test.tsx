import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { json, problem, renderApp } from '@/web/lib/test-utils.tsx';
import { ORG, templateDetail, templateSummary } from '../passes/test-fixtures.ts';
import { broadcast } from './test-fixtures.ts';

const MESSAGING = templateDetail({
  manifest: { inputs: templateDetail().inputSchema, messaging: { input: 'message' } },
});

type Handlers = Parameters<typeof renderApp>[1] extends infer O
  ? O extends { handlers?: infer H }
    ? NonNullable<H>
    : never
  : never;

function setup(
  path: string,
  extra: Handlers = {},
  preview: () => Response = () => json({ targeted: 1, onDevice: 1, overBudget: 0, limit: 3 }),
) {
  const created: unknown[] = [];
  const rendered = renderApp(path, {
    session: 'admin',
    handlers: {
      '/api/v1/orgs': () => json({ items: [ORG], nextCursor: null }),
      '/api/v1/templates': () => json({ items: [templateSummary()], nextCursor: null }),
      '/api/v1/templates/tpl1': () => json(MESSAGING),
      '/api/v1/broadcasts/preview': preview,
      '/api/v1/broadcasts': (_u, init) => {
        created.push(JSON.parse(String(init?.body)));
        return json(broadcast({ id: 'b9', orgId: 'org1', state: 'sending' }), 201);
      },
      '/api/v1/broadcasts/b9': () => json(broadcast({ id: 'b9', orgId: 'org1', state: 'sending' })),
      '/api/v1/broadcasts/b9/items': () => json({ items: [], nextCursor: null }),
      ...extra,
    },
  });
  return { created, rendered };
}

async function writeMessage(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('checkbox', { name: 'Copper card' }));
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Doors open at 8.');
}

describe('Message composer', () => {
  it('sends now and lands on the message', async () => {
    const { created } = setup('/admin/messages/new?orgId=org1');
    const user = userEvent.setup();
    await writeMessage(user);
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

  it('counts the audience once per settled edit, not per keystroke', async () => {
    const counts: unknown[] = [];
    setup('/admin/messages/new?orgId=org1', {}, () => {
      counts.push(1);
      return json({ targeted: 1, onDevice: 1, overBudget: 0, limit: 3 });
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox', { name: 'Copper card' }));
    await screen.findByText('1 pass, 1 on a device.');
    const before = counts.length;
    await user.type(screen.getByRole('textbox', { name: 'Search' }), 'sam');
    await screen.findByText('1 pass, 1 on a device.');
    await waitFor(() => expect(counts.length).toBeGreaterThan(before));
    expect(counts.length - before).toBeLessThanOrEqual(2);
  });

  it('schedules for a time and says when it goes out', async () => {
    const { created } = setup('/admin/messages/new?orgId=org1');
    const user = userEvent.setup();
    await writeMessage(user);
    await user.click(screen.getByRole('radio', { name: 'Schedule' }));
    const when = await screen.findByLabelText(/Send at/);
    fireEvent.change(when, { target: { value: '2999-01-01T09:00' } });
    await user.click(screen.getByRole('button', { name: 'Schedule' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Schedule for 1 pass?' });
    expect(within(confirm).getByText(/^Goes out /)).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Schedule' }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toEqual(
      expect.objectContaining({ send: 'schedule', at: expect.any(Number) }),
    );
  });

  it('saves a draft once however often it is pressed', async () => {
    const { created } = setup('/admin/messages/new?orgId=org1');
    const user = userEvent.setup();
    await writeMessage(user);
    const save = screen.getByRole('button', { name: 'Save draft' });
    await user.dblClick(save);
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toEqual(expect.objectContaining({ send: 'draft' }));
  });

  it('composes a change to chosen fields', async () => {
    const { created } = setup('/admin/messages/new?orgId=org1&kind=change');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox', { name: 'Copper card' }));
    await user.click(await screen.findByRole('checkbox', { name: 'Member name' }));
    await user.clear(await screen.findByRole('textbox', { name: /Member name/ }));
    await user.type(screen.getByRole('textbox', { name: /Member name/ }), 'Sam Lee');
    await screen.findByText('1 pass, 1 on a device.');
    await user.click(screen.getByRole('button', { name: 'Send now' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Send change to 1 pass?' });
    await user.click(within(confirm).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toEqual(
      expect.objectContaining({ kind: 'change', patch: { name: 'Sam Lee' } }),
    );
  });

  it('will not send to no passes', async () => {
    const { created } = setup('/admin/messages/new?orgId=org1', {}, () =>
      json({ targeted: 0, onDevice: 0, overBudget: 0, limit: 3 }),
    );
    const user = userEvent.setup();
    await writeMessage(user);
    await user.click(screen.getByRole('button', { name: 'Send now' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'No passes match' });
    expect(within(dialog).queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
    expect(created).toHaveLength(0);
  });

  it('says so when the passes cannot be counted', async () => {
    setup('/admin/messages/new?orgId=org1', {}, () => problem(500, 'server_error', 'Down.'));
    const user = userEvent.setup();
    await writeMessage(user);
    await user.click(screen.getByRole('button', { name: 'Send now' }));
    expect(
      await screen.findByRole('alertdialog', { name: 'Could not count the passes' }),
    ).toBeInTheDocument();
  });

  it('edits a saved draft, replacing it before it sends', async () => {
    const calls: string[] = [];
    const draft = broadcast({
      id: 'b5',
      orgId: 'org1',
      state: 'draft',
      startedAt: null,
      target: { templateIds: ['tpl1'] },
      patch: { message: 'First words' },
    });
    setup('/admin/messages/new?from=b5', {
      '/api/v1/broadcasts/b5': (_u, init) => {
        calls.push(`${init?.method ?? 'GET'} b5 ${String(init?.body ?? '')}`);
        return json(init?.method === 'PATCH' ? { ...draft, patch: { message: 'Second' } } : draft);
      },
      '/api/v1/broadcasts/b5/send': (_u, init) => {
        calls.push(`POST send ${String(init?.body)}`);
        return json({ ...draft, state: 'sending' });
      },
      '/api/v1/broadcasts/b5/items': () => json({ items: [], nextCursor: null }),
    });
    const user = userEvent.setup();
    const field = await screen.findByRole('textbox', { name: 'Message' });
    await waitFor(() => expect(field).toHaveValue('First words'));
    expect(screen.getByRole('heading', { name: 'Edit draft' })).toBeInTheDocument();
    await user.clear(field);
    await user.type(field, 'Second');
    await screen.findByText('1 pass, 1 on a device.');
    await user.click(screen.getByRole('button', { name: 'Send now' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Send to 1 pass?' });
    await user.click(within(confirm).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(calls.some((c) => c.startsWith('POST send'))).toBe(true));
    const patched = calls.find((c) => c.includes('PATCH'));
    expect(patched).toContain('"message":"Second"');
    expect(patched).toContain('"send":"draft"');
  });
});
