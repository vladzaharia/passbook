import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { resetModeForTests } from '../../../lib/mode.ts';
import { json, problem, renderApp } from '../../../lib/test-utils.tsx';
import { type Calls, endpoint, hooks, manager } from './test-fixtures.ts';

const open = (path: string, calls: Calls[], handlers = hooks(calls)) =>
  renderApp(path, { session: 'admin', memberships: [manager], selectedOrg: 'org1', handlers });
const sent = (calls: Calls[], method: string, path: string) =>
  calls.filter((c) => c.method === method && c.path === path);

afterEach(() => resetModeForTests());

const OUTBOUND = '/admin/connections/webhooks/new';
const next = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: 'Next' }));

/** Types the URL on the Endpoint step and moves to Events. */
async function typeUrl(user: ReturnType<typeof userEvent.setup>, url: string) {
  await user.type(await screen.findByRole('textbox', { name: /URL/ }), url);
}

describe('add endpoint (the outbound path of the wizard)', () => {
  it('creates, shows the secret once, then sends a test event', async () => {
    const user = userEvent.setup();
    const calls: Calls[] = [];
    await open(OUTBOUND, calls);
    expect(await screen.findByRole('heading', { name: 'Where to send', level: 2 })).toBeVisible();
    await typeUrl(user, 'https://hooks.example.com/passbook');
    await user.tab();
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === 'POST' &&
            c.search === '?validate=1' &&
            (c.body as { orgId?: string }).orgId === 'org1',
        ),
      ).toBe(true),
    );
    await next(user);
    expect(await screen.findByRole('heading', { name: 'Choose events', level: 2 })).toBeVisible();
    await next(user);
    await user.click(await screen.findByRole('button', { name: 'Add endpoint' }));
    expect(await screen.findByRole('heading', { name: 'Copy the secret', level: 2 })).toBeVisible();
    const post = calls.find((c) => c.method === 'POST' && c.search === '');
    // The session names the organization in the body; without it the API answers 400.
    expect(post?.body).toMatchObject({
      orgId: 'org1',
      url: 'https://hooks.example.com/passbook',
      eventTypes: ['pass.issued', 'pass.installed', 'pass.uninstalled', 'pass.scanned'],
      templateIds: null,
    });
    expect(screen.getByRole('button', { name: 'Next' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Copy signing secret' })).toBeVisible();
    await user.click(screen.getByRole('checkbox', { name: 'I saved the secret' }));
    await next(user);
    expect(
      await screen.findByRole('heading', { name: 'Check the signature', level: 2 }),
    ).toBeVisible();
    expect(screen.getByRole('region', { name: 'Node verify snippet' })).toBeVisible();
    await next(user);
    expect(await screen.findByRole('heading', { name: 'Send a test', level: 2 })).toBeVisible();
    const done = screen.getByRole('button', { name: 'Done' });
    expect(done).toHaveAttribute('aria-disabled', 'true');

    await user.click(screen.getByRole('button', { name: 'Send test' }));
    expect((await screen.findAllByText(/Delivered/)).length).toBeGreaterThan(0);
    expect(sent(calls, 'POST', '/api/v1/webhook-endpoints/we-new/test')).toHaveLength(1);
    await waitFor(() => expect(done).not.toHaveAttribute('aria-disabled'));
    await user.click(done);
    expect(
      await screen.findByRole('heading', { name: 'hooks.example.com is set up' }),
    ).toBeVisible();
    expect(screen.getByText(/Delivered · 200 in 140 ms/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Open endpoint' }));
    expect(
      await screen.findByRole('heading', { name: 'hooks.example.com', level: 1 }),
    ).toBeVisible();
  });

  it('ticks a set of events from a quick pick and keeps the ticks editable', async () => {
    const user = userEvent.setup();
    const calls: Calls[] = [];
    await open(OUTBOUND, calls);
    await typeUrl(user, 'https://hooks.example.com/x');
    await next(user);
    const picks = await screen.findByRole('group', { name: 'Quick picks' });
    expect(within(picks).getAllByRole('button')).toHaveLength(6);
    await user.click(within(picks).getByRole('button', { name: 'Scans' }));
    expect(within(picks).getByRole('button', { name: 'Scans' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('checkbox', { name: 'Scanned' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Refused' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Issued' })).not.toBeChecked();
    await user.click(screen.getByRole('checkbox', { name: 'Refused' }));
    expect(within(picks).getByRole('button', { name: 'Scans' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await user.click(within(picks).getByRole('button', { name: 'All' }));
    expect(screen.getByRole('checkbox', { name: 'Issued' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Print voided' })).toBeChecked();
  });

  it('blocks an empty URL and no events, and names the problem', async () => {
    const user = userEvent.setup();
    const calls: Calls[] = [];
    await open(OUTBOUND, calls);
    await screen.findByRole('textbox', { name: /URL/ });
    await next(user);
    expect(await screen.findByText('Enter the URL.')).toBeVisible();
    await user.type(screen.getByRole('textbox', { name: /URL/ }), 'http://plain.example.com');
    await next(user);
    expect(await screen.findByText('Use an https URL.')).toBeVisible();
    expect(calls.some((c) => c.method === 'POST' && c.search === '')).toBe(false);
    await user.clear(screen.getByRole('textbox', { name: /URL/ }));
    await user.type(screen.getByRole('textbox', { name: /URL/ }), 'https://hooks.example.com/x');
    await next(user);
    for (const box of await screen.findAllByRole('checkbox', { checked: true }))
      await user.click(box);
    await next(user);
    expect(await screen.findByText('Pick at least one event.')).toBeVisible();
  });

  it('shows the save-time refusal under the URL', async () => {
    const user = userEvent.setup();
    const calls: Calls[] = [];
    await open(
      OUTBOUND,
      calls,
      hooks(calls, undefined, {
        '/api/v1/webhook-endpoints': () => problem(422, 'UNSAFE_URL', 'That host is not allowed.'),
      }),
    );
    await typeUrl(user, 'https://10.0.0.1/x');
    await user.tab();
    expect(await screen.findByText('That host is not allowed.')).toBeVisible();
    await user.type(screen.getByRole('textbox', { name: /URL/ }), 'y');
    await waitFor(() => expect(screen.queryByText('That host is not allowed.')).toBeNull());
  });

  it('stays on Review and says so when the endpoint limit is reached', async () => {
    const user = userEvent.setup();
    const calls: Calls[] = [];
    await open(
      OUTBOUND,
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
    await typeUrl(user, 'https://hooks.example.com/x');
    await next(user);
    await next(user);
    await user.click(await screen.findByRole('button', { name: 'Add endpoint' }));
    expect(
      await screen.findByText('This mode already has 10 endpoints. Delete one first.'),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add endpoint' })).toBeVisible();
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
    expect(within(dialog).getAllByRole('radio')).toHaveLength(5);
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

  it('confirms getsOf deleting', async () => {
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
    expect(
      await screen.findByRole('tab', { name: 'Webhook endpoints', selected: true }),
    ).toBeVisible();
  });

  it('sends a test event and reports a delivery', async () => {
    const user = userEvent.setup();
    const calls: Calls[] = [];
    await open('/admin/connections/webhooks/we1', calls);
    await user.click(await screen.findByRole('button', { name: 'Send test' }));
    expect((await screen.findAllByText(/Delivered/)).length).toBeGreaterThan(0);
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
            JSON.stringify({
              ok: false,
              status: 503,
              durationMs: 90,
              errorCode: null,
              captureId: null,
            }),
            {
              headers: { 'content-type': 'application/json' },
            },
          ),
      }),
    );
    await user.click(await screen.findByRole('button', { name: 'Send test' }));
    expect(await screen.findByText('Server error')).toBeVisible();
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
    await user.click(await screen.findByRole('button', { name: 'Send test' }));
    expect(
      (await screen.findAllByText('Too many test events. Try again in a minute.')).length,
    ).toBeGreaterThan(0);
  });
});

describe('secrets, focus, sending and lookups', () => {
  const secretsInCache = (qc: {
    getMutationCache: () => { getAll: () => { state: { data?: unknown } }[] };
  }) =>
    qc
      .getMutationCache()
      .getAll()
      .filter((m) => JSON.stringify(m.state.data ?? '').includes('whsec_'));

  it('moves focus to the secret step and keeps the secret out of the mutation cache (create)', async () => {
    const user = userEvent.setup();
    const calls: Calls[] = [];
    const { queryClient } = await open(OUTBOUND, calls);
    await typeUrl(user, 'https://hooks.example.com/x');
    await next(user);
    await next(user);
    await user.click(await screen.findByRole('button', { name: 'Add endpoint' }));
    const heading = await screen.findByRole('heading', { name: 'Copy the secret', level: 2 });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(secretsInCache(queryClient)).toEqual([]);
  });

  it('moves focus to the secret and keeps it out of the mutation cache (rotate)', async () => {
    const user = userEvent.setup();
    const calls: Calls[] = [];
    const { queryClient } = await open('/admin/connections/webhooks/we1', calls);
    await user.click(await screen.findByRole('button', { name: 'More' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rotate secret' }));
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Rotate secret' })).getByRole('button', {
        name: 'Rotate',
      }),
    );
    const group = await screen.findByRole('group', { name: 'New signing secret' });
    await waitFor(() => expect(group).toHaveFocus());
    expect(secretsInCache(queryClient)).toEqual([]);
  });

  it('says Sending… while the test request is out, then refreshes the endpoint', async () => {
    const user = userEvent.setup();
    const calls: Calls[] = [];
    let release: (r: Response) => void = () => {};
    await open(
      '/admin/connections/webhooks/we1',
      calls,
      hooks(calls, undefined, {
        '/api/v1/webhook-endpoints/we1/test': () => new Promise<Response>((r) => (release = r)),
      }),
    );
    const getsOf = () =>
      calls.filter((c) => c.method === 'GET' && c.path === '/api/v1/webhook-endpoints/we1').length;
    await screen.findByRole('heading', { name: 'Settings' });
    const gets = getsOf();
    await user.click(screen.getByRole('button', { name: 'Send test' }));
    expect((await screen.findAllByText('Sending a test.')).length).toBeGreaterThan(0);
    release(json({ ok: true, status: 200, durationMs: 5, errorCode: null, captureId: null }));
    await waitFor(() => expect(getsOf()).toBeGreaterThan(gets));
    await waitFor(() => expect(screen.queryByText('Sending a test.')).toBeNull());
  });

  it('names a missing endpoint a webhook', async () => {
    const calls: Calls[] = [];
    await open(
      '/admin/connections/webhooks/we1',
      calls,
      hooks(calls, undefined, {
        '/api/v1/webhook-endpoints/we1': () => problem(404, 'not_found', 'Not found.'),
      }),
    );
    expect(await screen.findByText('Webhook not found')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to webhooks' })).toBeVisible();
  });
});

describe('endpoint helpers', () => {
  it('shows nothing extra for a healthy endpoint', async () => {
    const calls: Calls[] = [];
    await open('/admin/connections/webhooks/we1', calls, hooks(calls, { endpoints: [endpoint()] }));
    await screen.findByRole('heading', { name: 'Settings' });
    expect(screen.queryByText('Deliveries are failing')).toBeNull();
  });
});
