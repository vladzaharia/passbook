import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { type FetchHandler, json, renderApp } from '../../../lib/test-utils.tsx';
import { ORG, passDetail, passSummary, templateDetail, templateSummary } from '../test-fixtures.ts';

const NOW = Date.now();
const device = (over: Record<string, unknown>) => ({
  device: 'a1b2c3d4e5f6',
  status: 'current',
  registeredAt: NOW - 86_400_000,
  unregisteredAt: null,
  lastFetch: { at: NOW - 120_000, version: 3, httpStatus: 200 },
  lastPush: { at: NOW - 180_000, ok: true, version: 3, httpStatus: 200, reason: null },
  removal: null,
  ...over,
});

function handlers(extra: Record<string, FetchHandler>): Record<string, FetchHandler> {
  return {
    '/api/v1/orgs': () => json({ items: [ORG], nextCursor: null }),
    '/api/v1/templates': () => json({ items: [templateSummary()], nextCursor: null }),
    '/api/v1/templates/tpl1': () => json(templateDetail()),
    '/api/v1/passes': () => json({ items: [passSummary()], nextCursor: null }),
    '/api/v1/passes/p1': () => json(passDetail()),
    '/api/v1/passes/p1/assets': () => json({ items: [] }),
    ...extra,
  };
}

describe('Devices tab', () => {
  it('shows a status pill per device and how many are up to date', async () => {
    const { container } = await renderApp('/admin/passes/p1?tab=devices', {
      session: 'admin',
      handlers: handlers({
        '/api/v1/passes/p1/devices': () =>
          json({
            version: 3,
            removal: null,
            devices: [
              device({}),
              device({
                device: 'f6e5d4c3b2a1',
                status: 'push_failing',
                lastFetch: null,
                lastPush: {
                  at: NOW - 60_000,
                  ok: false,
                  version: 3,
                  httpStatus: 400,
                  reason: 'BadDeviceToken',
                },
              }),
              device({
                device: '0123456789ab',
                status: 'removed',
                registeredAt: null,
                unregisteredAt: NOW - 3_600_000,
              }),
            ],
          }),
      }),
    });
    const list = await screen.findByRole('list', { name: 'Devices' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Up to date');
    expect(rows[0]).toHaveTextContent('Fetched v3 (200)');
    expect(rows[1]).toHaveTextContent('Push failing');
    expect(rows[1]).toHaveTextContent('Push failed v3: BadDeviceToken');
    expect(rows[1]).toHaveTextContent('Never fetched');
    expect(rows[2]).toHaveTextContent('Stopped updates');
    expect(screen.getByText('1 of 2 devices up to date')).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('shows removal progress per device', async () => {
    await renderApp('/admin/passes/p1?tab=devices', {
      session: 'admin',
      handlers: handlers({
        '/api/v1/passes/p1': () => json(passDetail({ status: 'voided', removedAt: NOW - 5000 })),
        '/api/v1/passes/p1/devices': () =>
          json({
            version: 4,
            removal: { removedAt: NOW - 5000, version: 4, total: 2, done: 1 },
            devices: [
              device({ removal: 'fetched' }),
              device({ device: 'f6e5d4c3b2a1', removal: 'pending' }),
            ],
          }),
      }),
    });
    expect(await screen.findByText('Removed on 1 of 2 devices')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Devices updated' })).toHaveAttribute(
      'aria-valuenow',
      '1',
    );
    expect(screen.getAllByText(/delete it there/).length).toBeGreaterThan(0);
    const rows = within(screen.getByRole('list', { name: 'Devices' })).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Removed');
    expect(rows[1]).toHaveTextContent('Waiting');
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Void' })).toBeNull();
  });
});

describe('Sync log tab', () => {
  const event = (
    id: string,
    kind: string,
    at: number,
    data: object = {},
    dev: string | null = null,
  ) => ({
    id,
    passId: 'p1',
    mode: 'live',
    kind,
    device: dev,
    actorType: null,
    actorId: null,
    data,
    at,
  });

  it('groups a version with its push and fetches, and filters by group', async () => {
    const queries: string[] = [];
    await renderApp('/admin/passes/p1?tab=sync', {
      session: 'admin',
      handlers: handlers({
        '/api/v1/passes/p1/events': (url) => {
          queries.push(new URL(url, 'http://x').search);
          return json({
            nextCursor: null,
            items: [
              event(
                'e5',
                'device.fetched',
                NOW - 50_000,
                { step: 'file', version: 3, status: 200 },
                'a1b2c3d4e5f6',
              ),
              event('e4', 'push.sent', NOW - 62_000, { version: 3, status: 200 }, 'a1b2c3d4e5f6'),
              event('e3', 'push.queued', NOW - 63_000, { version: 3, devices: 1 }),
              event('e2', 'pass.updated', NOW - 63_500, { version: 3, notified: false }),
              event('e1', 'email.sent', NOW - 900_000, { outboxId: 'o1' }),
            ],
          });
        },
      }),
    });
    const log = await screen.findByRole('list', { name: 'Sync log' });
    const [group, email] = Array.from(log.querySelectorAll(':scope > li'));
    expect(group).toHaveTextContent('Updated to v3');
    expect(group).toHaveTextContent('Pushed to 1 device');
    expect(group).toHaveTextContent('1 fetched in 13 s');
    expect(email).toHaveTextContent('Email sent');
    const user = userEvent.setup();
    await user.click(within(group as HTMLElement).getByRole('button', { name: /Show 4 events/ }));
    expect(within(group as HTMLElement).getByText('Fetched the pass')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Delivery' }));
    await waitFor(() => expect(queries.some((q) => q.includes('group=delivery'))).toBe(true));
  });

  it('has an empty state per filter', async () => {
    await renderApp('/admin/passes/p1?tab=sync', {
      session: 'admin',
      handlers: handlers({
        '/api/v1/passes/p1/events': () => json({ items: [], nextCursor: null }),
      }),
    });
    expect(await screen.findByText('Nothing recorded yet')).toBeInTheDocument();
  });
});

describe('Remove from Wallet', () => {
  it('asks with the one limit, sends the message and says what happened', async () => {
    const bodies: unknown[] = [];
    const user = userEvent.setup();
    await renderApp('/admin/passes/p1', {
      session: 'admin',
      handlers: handlers({
        '/api/v1/passes/p1/remove': (_u, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return json(passSummary({ status: 'voided', removedAt: NOW }));
        },
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'More' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove from Wallet' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove from Wallet?' });
    expect(dialog).toHaveTextContent('the holder can delete it there');
    await user.type(within(dialog).getByLabelText(/Message for holders/), 'Use the new app');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(bodies).toEqual([{ message: 'Use the new app' }]));
  });
});
