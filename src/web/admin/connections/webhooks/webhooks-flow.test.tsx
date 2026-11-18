import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { resetModeForTests } from '../../../lib/mode.ts';
import { problem, renderApp } from '../../../lib/test-utils.tsx';
import { type Calls, endpoint, hooks, manager } from './test-fixtures.ts';

const open = (path: string, calls: Calls[], handlers = hooks(calls)) =>
  renderApp(path, { session: 'admin', memberships: [manager], selectedOrg: 'org1', handlers });
const sent = (calls: Calls[], method: string, path: string) =>
  calls.filter((c) => c.method === method && c.path === path);

afterEach(() => resetModeForTests());

describe('add endpoint', () => {
  it('creates, shows the secret once, then sends a test event', async () => {
    const user = userEvent.setup();
    const calls: Calls[] = [];
    await open('/admin/connections/webhooks/new', calls);
    const url = await screen.findByRole('textbox', { name: /URL/ });
    await user.type(url, 'https://hooks.example.com/passbook');
    await user.tab();
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.search === '?validate=1')).toBe(true),
    );
    await user.click(screen.getByRole('button', { name: 'Add endpoint' }));
    expect(await screen.findByRole('heading', { name: 'Signing secret' })).toBeVisible();
    const post = calls.find((c) => c.method === 'POST' && c.search === '');
    expect(post?.body).toMatchObject({
      url: 'https://hooks.example.com/passbook',
      eventTypes: ['pass.issued', 'pass.installed', 'pass.uninstalled', 'pass.scanned'],
      templateIds: null,
    });
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Copy signing secret' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Verify snippet' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Send test event' }));
    expect(await screen.findByText('Delivered: 200 in 140 ms', { selector: 'span' })).toBeVisible();
    expect(sent(calls, 'POST', '/api/v1/webhook-endpoints/we-new/test')).toHaveLength(1);

    await user.click(screen.getByRole('checkbox', { name: 'I saved the secret' }));
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(
      await screen.findByRole('heading', { name: 'hooks.example.com', level: 1 }),
    ).toBeVisible();
  });

  it('blocks an empty URL and no events, and names the problem', async () => {
    const user = userEvent.setup();
    const calls: Calls[] = [];
    await open('/admin/connections/webhooks/new', calls);
    await user.click(await screen.findByRole('button', { name: 'Add endpoint' }));
    expect(await screen.findByText('Enter the URL.')).toBeVisible();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await user.type(screen.getByRole('textbox', { name: /URL/ }), 'http://plain.example.com');
    await user.click(screen.getByRole('button', { name: 'Add endpoint' }));
    expect(await screen.findByText('Use an https URL.')).toBeVisible();
  });

  it('shows the save-time refusal under the URL', async () => {
    const user = userEvent.setup();
    const calls: Calls[] = [];
    await open(
      '/admin/connections/webhooks/new',
      calls,
      hooks(calls, undefined, {
        '/api/v1/webhook-endpoints': () => problem(422, 'UNSAFE_URL', 'That host is not allowed.'),
      }),
    );
    await user.type(await screen.findByRole('textbox', { name: /URL/ }), 'https://10.0.0.1/x');
    await user.tab();
    expect(await screen.findByText('That host is not allowed.')).toBeVisible();
    await user.type(screen.getByRole('textbox', { name: /URL/ }), 'y');
    await waitFor(() => expect(screen.queryByText('That host is not allowed.')).toBeNull());
  });

  it('keeps the form and says so when the endpoint limit is reached', async () => {
    const user = userEvent.setup();
    const calls: Calls[] = [];
    await open(
      '/admin/connections/webhooks/new',
      calls,
      hooks(calls, undefined, {
        '/api/v1/webhook-endpoints': (_u, init) =>
          (init?.method ?? 'GET') === 'POST'
            ? problem(
                409,
                'WEBHOOK_ENDPOINT_LIMIT',
                'This mode already has 10 endpoints. Delete one first.',
              )
            : new Response(JSON.stringify({ items: [] }), {
                headers: { 'content-type': 'application/json' },
              }),
      }),
    );
    await user.type(
      await screen.findByRole('textbox', { name: /URL/ }),
      'https://hooks.example.com/x',
    );
    await user.click(screen.getByRole('button', { name: 'Add endpoint' }));
    expect(
      await screen.findByText('This mode already has 10 endpoints. Delete one first.'),
    ).toBeVisible();
    expect(screen.getByRole('textbox', { name: /URL/ })).toHaveValue('https://hooks.example.com/x');
  });
});

describe('endpoint actions', () => {
  it('saves only the fields that changed', async () => {
    const user = userEvent.setup();
    const calls: Calls[] = [];
    await open('/admin/connections/webhooks/we1', calls);
    const description = await screen.findByRole('textbox', { name: /Description/ });
    await user.clear(description);
    await user.type(description, 'Billing');
    await user.click(screen.getByRole('checkbox', { name: 'Scanned' }));
    await user.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(sent(calls, 'PATCH', '/api/v1/webhook-endpoints/we1')).toHaveLength(1),
    );
    expect(sent(calls, 'PATCH', '/api/v1/webhook-endpoints/we1')[0]?.body).toEqual({
      description: 'Billing',
      eventTypes: ['pass.issued'],
    });
    expect(await screen.findByText('Saved', { selector: '[data-title]' })).toBeVisible();
  });

  it('pauses and resumes', async () => {
    const user = userEvent.setup();
    const calls: Calls[] = [];
    await open('/admin/connections/webhooks/we1', calls);
    await user.click(await screen.findByRole('button', { name: 'More' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Pause' }));
    await waitFor(() =>
      expect(sent(calls, 'PATCH', '/api/v1/webhook-endpoints/we1')[0]?.body).toEqual({
        status: 'paused',
      }),
    );
    expect(await screen.findByText('Nothing is sent until you resume.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() =>
      expect(sent(calls, 'PATCH', '/api/v1/webhook-endpoints/we1')[1]?.body).toEqual({
        status: 'active',
      }),
    );
  });

  it('rotates with an overlap and shows the new secret once', async () => {
    const user = userEvent.setup();
    const calls: Calls[] = [];
    await open('/admin/connections/webhooks/we1', calls);
    await user.click(await screen.findByRole('button', { name: 'More' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rotate secret' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rotate secret' });
    expect(within(dialog).getByRole('radio', { name: '24 hours' })).toBeChecked();
    await user.click(within(dialog).getByRole('radio', { name: '3 days' }));
    await user.click(within(dialog).getByRole('button', { name: 'Rotate' }));
    expect(await screen.findByRole('dialog', { name: 'New signing secret' })).toBeVisible();
    expect(sent(calls, 'POST', '/api/v1/webhook-endpoints/we1/secret')[0]?.body).toEqual({
      overlapHours: 72,
    });
    const done = screen.getByRole('button', { name: 'Done' });
    expect(done).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'I saved the secret' }));
    await user.click(done);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('confirms before deleting', async () => {
    const user = userEvent.setup();
    const calls: Calls[] = [];
    await open('/admin/connections/webhooks/we1', calls);
    await user.click(await screen.findByRole('button', { name: 'More' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/Pending deliveries are dropped/)).toBeVisible();
    expect(sent(calls, 'DELETE', '/api/v1/webhook-endpoints/we1')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(sent(calls, 'DELETE', '/api/v1/webhook-endpoints/we1')).toHaveLength(1),
    );
    expect(await screen.findByRole('tab', { name: 'Webhooks', selected: true })).toBeVisible();
  });

  it('sends a test event and reports a delivery', async () => {
    const user = userEvent.setup();
    const calls: Calls[] = [];
    await open('/admin/connections/webhooks/we1', calls);
    await user.click(await screen.findByRole('button', { name: 'Send test event' }));
    expect(await screen.findByText('Delivered', { selector: '[role=status] *' })).toBeVisible();
    expect(sent(calls, 'POST', '/api/v1/webhook-endpoints/we1/test')).toHaveLength(1);
  });

  it('words a failed test with the endpoint response, not a crash', async () => {
    const user = userEvent.setup();
    const calls: Calls[] = [];
    await open(
      '/admin/connections/webhooks/we1',
      calls,
      hooks(calls, undefined, {
        '/api/v1/webhook-endpoints/we1/test': () =>
          new Response(
            JSON.stringify({ ok: false, status: 503, durationMs: 90, errorCode: null }),
            {
              headers: { 'content-type': 'application/json' },
            },
          ),
      }),
    );
    await user.click(await screen.findByRole('button', { name: 'Send test event' }));
    expect((await screen.findAllByText('Failed: HTTP 503')).length).toBeGreaterThan(0);
    expect(await screen.findByText('Check the endpoint.')).toBeVisible();
  });

  it('reports a refused test (rate limit) as an error', async () => {
    const user = userEvent.setup();
    const calls: Calls[] = [];
    await open(
      '/admin/connections/webhooks/we1',
      calls,
      hooks(calls, undefined, {
        '/api/v1/webhook-endpoints/we1/test': () =>
          problem(429, 'RATE_LIMITED', 'Too many test events. Try again in a minute.'),
      }),
    );
    await user.click(await screen.findByRole('button', { name: 'Send test event' }));
    expect(
      (await screen.findAllByText('Too many test events. Try again in a minute.')).length,
    ).toBeGreaterThan(0);
  });
});

describe('endpoint helpers', () => {
  it('shows nothing extra for a healthy endpoint', async () => {
    const calls: Calls[] = [];
    await open('/admin/connections/webhooks/we1', calls, hooks(calls, { endpoints: [endpoint()] }));
    await screen.findByRole('table', { name: 'Deliveries' });
    expect(screen.queryByText('Deliveries are failing')).toBeNull();
  });
});
