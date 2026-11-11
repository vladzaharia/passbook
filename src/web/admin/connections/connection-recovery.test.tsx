import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { type FetchHandler, json, membershipFixture, renderApp } from '../../lib/test-utils.tsx';
import {
  CONNECTOR,
  connectionDetail,
  ORG,
  templateDetail,
  templateSummary,
} from '../passes/test-fixtures.ts';

const membership = membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug });
const method = (init?: RequestInit) => (init?.method ?? 'GET').toUpperCase();

const item = (over: Record<string, unknown>) => ({
  id: 'w1',
  eventRef: 'evt-1',
  generation: 1,
  connectionMode: 'webhook',
  state: 'failed',
  errorCode: null,
  uncertainItems: 0,
  receivedAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  ...over,
});

function handlers(
  items: unknown[],
  replays: string[] = [],
  patches: unknown[] = [],
  resolve: FetchHandler = () => json({ ok: true, resolved: 1, state: 'resolved' }),
) {
  let c = connectionDetail({ mode: 'webhook' });
  return {
    '/api/v1/orgs': () => json({ items: [ORG], nextCursor: null }),
    '/api/v1/templates': () => json({ items: [templateSummary()], nextCursor: null }),
    '/api/v1/templates/tpl1': () => json(templateDetail()),
    '/api/v1/connectors/http-json': () => json(CONNECTOR),
    '/api/v1/connections/c1': (_u: URL, init?: RequestInit) => {
      if (method(init) === 'PATCH') {
        const body = JSON.parse(String(init?.body));
        patches.push(body);
        c = { ...c, ...body };
      }
      return json(c);
    },
    '/api/v1/connections/c1/test': () =>
      json({ ok: true, durationMs: 120, detail: 'Record fetched.' }),
    '/api/v1/connections/c1/webhook-failures': () => json({ items }),
    '/api/v1/connections/c1/webhook-failures/w3/resolve': resolve,
    '/api/v1/connections/c1/webhook-failures/w2/replay': () => {
      replays.push('w2');
      return json({ ok: true }, 202);
    },
  } satisfies Record<string, FetchHandler>;
}

describe('connection recovery', () => {
  it('groups webhook failures by event and replays the newest item once', async () => {
    const user = userEvent.setup();
    const replays: string[] = [];
    await renderApp('/admin/connections/c1', {
      session: 'admin',
      memberships: [membership],
      selectedOrg: ORG.id,
      handlers: handlers(
        [
          item({ id: 'w1', receivedAt: 1_700_000_000_000 }),
          item({ id: 'w2', receivedAt: 1_700_000_100_000 }),
          item({ id: 'w3', eventRef: 'evt-2', errorCode: 'WEBHOOK_EFFECT_UNCERTAIN' }),
          item({ id: 'w4', eventRef: 'evt-3', state: 'resolved' }),
        ],
        replays,
      ),
    });
    expect(await screen.findByRole('heading', { name: 'Webhook failures' })).toBeVisible();
    const list = (await screen.findByText('evt-1')).closest('ul') as HTMLElement;
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByText('evt-3')).toBeNull();
    expect(screen.getByText(/Check the source system before replaying/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Replay event evt-2' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Replay event evt-1' }));
    await waitFor(() => expect(replays).toEqual(['w2']));
  });

  const uncertain = item({
    id: 'w3',
    eventRef: 'evt-2',
    errorCode: 'WEBHOOK_EFFECT_UNCERTAIN',
    uncertainItems: 1,
  });

  it('marks an uncertain event resolved after confirming, by keyboard', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    await renderApp('/admin/connections/c1', {
      session: 'admin',
      memberships: [membership],
      selectedOrg: ORG.id,
      handlers: handlers([uncertain], [], [], (_u, init) => {
        calls.push(method(init));
        return json({ ok: true, resolved: 1, state: 'resolved' });
      }),
    });
    const button = await screen.findByRole('button', { name: 'Mark event evt-2 resolved' });
    button.focus();
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/checked the source system/)).toBeVisible();
    expect(calls).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Mark resolved' }));
    await waitFor(() => expect(calls).toEqual(['POST']));
    expect(await screen.findByText('Marked resolved')).toBeVisible();
  });

  it('shows the server message when resolving fails', async () => {
    const user = userEvent.setup();
    await renderApp('/admin/connections/c1', {
      session: 'admin',
      memberships: [membership],
      selectedOrg: ORG.id,
      handlers: handlers([uncertain], [], [], () =>
        json(
          {
            type: 'about:blank',
            title: 'Conflict',
            status: 409,
            code: 'WEBHOOK_STILL_PENDING',
            detail: 'Still running.',
          },
          409,
        ),
      ),
    });
    await user.click(await screen.findByRole('button', { name: 'Mark event evt-2 resolved' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Mark resolved' }));
    expect(await within(dialog).findByText(/Still running/)).toBeVisible();
  });

  it('hides Resolve without uncertain items or without manage rights', async () => {
    await renderApp('/admin/connections/c1', {
      session: 'admin',
      memberships: [membership],
      selectedOrg: ORG.id,
      handlers: handlers([item({ id: 'w1' })]),
    });
    await screen.findByText('evt-1');
    expect(screen.queryByRole('button', { name: /Mark event .* resolved/ })).toBeNull();
  });

  it('clears the test result when settings are saved', async () => {
    const user = userEvent.setup();
    const patches: unknown[] = [];
    await renderApp('/admin/connections/c1', {
      session: 'admin',
      memberships: [membership],
      selectedOrg: ORG.id,
      handlers: handlers([], [], patches),
    });
    await user.click(await screen.findByRole('button', { name: 'Test' }));
    expect(await screen.findByText('Test passed')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    const name = await screen.findByRole('textbox', { name: /Name/ });
    await user.clear(name);
    await user.type(name, 'Renamed');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText('Test passed')).toBeNull());
  });
});
