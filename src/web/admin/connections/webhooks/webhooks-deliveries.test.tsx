import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { resetModeForTests } from '../../../lib/mode.ts';
import { json, problem, renderApp } from '../../../lib/test-utils.tsx';
import { type Calls, delivery, endpoint, hooks, manager, reader } from './test-fixtures.ts';

const PATH = '/api/v1/webhook-endpoints/we1';
const open = (calls: Calls[], handlers = hooks(calls), as = manager) =>
  renderApp('/admin/connections/webhooks/we1?tab=deliveries', {
    session: 'admin',
    memberships: [as],
    selectedOrg: 'org1',
    handlers,
  });
const sent = (calls: Calls[], method: string, path: string) =>
  calls.filter((c) => c.method === method && c.path === path);

afterEach(() => resetModeForTests());

describe('deliveries', () => {
  it('lists deliveries with status and the response in words', async () => {
    const calls: Calls[] = [];
    const state = {
      endpoints: [endpoint()],
      deliveries: [
        delivery(),
        delivery({ eventId: 'ev2', state: 'delivered', lastStatus: 200, type: 'pass.issued' }),
        delivery({ eventId: 'ev3', lastStatus: null, lastError: 'TIMEOUT', type: 'pass.voided' }),
        delivery({ eventId: 'ev4', lastStatus: null, lastError: 'UNSAFE_URL', state: 'cancelled' }),
      ],
    };
    await open(calls, hooks(calls, state));
    const table = await screen.findByRole('table', { name: 'Deliveries' });
    expect(within(table).getByText('HTTP 503')).toBeVisible();
    expect(within(table).getByText('HTTP 200')).toBeVisible();
    expect(within(table).getByText('No answer in 10 s')).toBeVisible();
    expect(within(table).getByText('Host not allowed')).toBeVisible();
    expect(within(table).getByText('Cancelled')).toBeVisible();
    expect(within(table).getAllByText('ORD-7').length).toBeGreaterThan(0);
  });

  it('shows no verdict in Response for a pending or cancelled delivery without an answer', async () => {
    const calls: Calls[] = [];
    const state = {
      endpoints: [endpoint()],
      deliveries: [
        delivery({ eventId: 'ev2', state: 'pending', lastStatus: null, lastError: null }),
        delivery({ eventId: 'ev3', state: 'cancelled', lastStatus: null, lastError: null }),
      ],
    };
    await open(calls, hooks(calls, state));
    const table = await screen.findByRole('table', { name: 'Deliveries' });
    expect(within(table).getByText('Pending')).toBeVisible();
    expect(within(table).getByText('Cancelled')).toBeVisible();
    expect(within(table).queryByText('Failed')).toBeNull();
  });

  it('offers Replay only once something was delivered or failed', async () => {
    const calls: Calls[] = [];
    const none = { endpoints: [endpoint({ lastSuccessAt: null, lastFailureAt: null })] };
    await open(calls, hooks(calls, none));
    await screen.findByRole('table', { name: 'Deliveries' });
    expect(screen.queryByRole('button', { name: 'Replay' })).toBeNull();
  });

  it('says Disabled once: the pill, not also a banner title', async () => {
    const calls: Calls[] = [];
    const off = { endpoints: [endpoint({ status: 'disabled', disabledAt: 1, failingSince: 0 })] };
    await open(calls, hooks(calls, off));
    await screen.findByRole('table', { name: 'Deliveries' });
    expect(screen.getAllByText('Disabled')).toHaveLength(1);
    expect(screen.getByText(/Fix the endpoint, then resume/)).toBeVisible();
  });

  it('names a pass without an issuer id by the tail of its PassBook id', async () => {
    const calls: Calls[] = [];
    const state = {
      endpoints: [endpoint()],
      deliveries: [delivery({ externalId: null, passId: 'p1234567890' })],
    };
    await open(calls, hooks(calls, state));
    const table = await screen.findByRole('table', { name: 'Deliveries' });
    expect(within(table).getByRole('link', { name: 'Pass 567890' })).toBeVisible();
  });

  it('lists a test send tagged Test beside the deliveries, only under All', async () => {
    const user = userEvent.setup();
    const calls: Calls[] = [];
    await open(calls);
    const table = await screen.findByRole('table', { name: 'Deliveries' });
    expect(await within(table).findByText('Test')).toBeVisible();
    expect(within(table).getByText('Sent')).toBeVisible();
    await user.click(screen.getByRole('radio', { name: 'Failed' }));
    await waitFor(() => expect(within(table).queryByText('Sent')).toBeNull());
  });

  it('filters to failed deliveries through the API', async () => {
    const user = userEvent.setup();
    const calls: Calls[] = [];
    await open(calls);
    await screen.findByRole('table', { name: 'Deliveries' });
    await user.click(screen.getByRole('radio', { name: 'Failed' }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.path === `${PATH}/deliveries` && c.search.includes('state=failed')),
      ).toBe(true),
    );
  });

  it('shows an empty line for a filter with no rows', async () => {
    const user = userEvent.setup();
    const calls: Calls[] = [];
    await open(calls);
    await screen.findByRole('table', { name: 'Deliveries' });
    await user.click(screen.getByRole('radio', { name: 'Pending' }));
    expect(await screen.findByText('Nothing pending')).toBeVisible();
  });

  it('opens a row to attempts and payload, and replays it', async () => {
    const user = userEvent.setup();
    const calls: Calls[] = [];
    await open(calls);
    await user.click(await screen.findByRole('button', { name: /^Scanned,/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Delivery' });
    expect(await within(sheet).findByText('First send: HTTP 503')).toBeVisible();
    expect(within(sheet).getByText('Retry: No answer in 10 s')).toBeVisible();
    expect(within(sheet).getByRole('region', { name: 'Payload JSON' })).toHaveTextContent(
      'pass.scanned',
    );
    await user.click(within(sheet).getByRole('button', { name: 'Replay' }));
    await waitFor(() =>
      expect(sent(calls, 'POST', `${PATH}/deliveries/ev1/replay`)).toHaveLength(1),
    );
    expect(await screen.findByText('Queued 1 delivery.')).toBeVisible();
  });

  it('hides Replay from a reader', async () => {
    const user = userEvent.setup();
    const calls: Calls[] = [];
    await open(calls, hooks(calls, { endpoints: [endpoint({ url: null })] }), reader);
    await user.click(await screen.findByRole('button', { name: /^Scanned,/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Delivery' });
    await within(sheet).findByText('First send: HTTP 503');
    expect(within(sheet).queryByRole('button', { name: 'Replay' })).toBeNull();
  });

  it('says a pending delivery is already waiting (409)', async () => {
    const user = userEvent.setup();
    const calls: Calls[] = [];
    await open(
      calls,
      hooks(calls, undefined, {
        [`${PATH}/deliveries/ev1/replay`]: () =>
          problem(409, 'DELIVERY_PENDING', 'This delivery is already waiting to be sent.'),
      }),
    );
    await user.click(await screen.findByRole('button', { name: /^Scanned,/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Delivery' });
    await user.click(await within(sheet).findByRole('button', { name: 'Replay' }));
    expect(await within(sheet).findByText('It is already waiting to be sent.')).toBeVisible();
  });
});

describe('row replay and reset state', () => {
  it('replays a failed row from the list, and disables a pending one', async () => {
    const user = userEvent.setup();
    const calls: Calls[] = [];
    const state = {
      endpoints: [endpoint()],
      deliveries: [delivery(), delivery({ eventId: 'ev2', state: 'pending', type: 'pass.issued' })],
    };
    await open(calls, hooks(calls, state));
    await screen.findByRole('table', { name: 'Deliveries' });
    expect(screen.getByRole('button', { name: 'Replay Issued delivery' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Replay Scanned delivery' }));
    await waitFor(() =>
      expect(sent(calls, 'POST', `${PATH}/deliveries/ev1/replay`)).toHaveLength(1),
    );
    expect(await screen.findByText('Queued 1 delivery.')).toBeVisible();
  });

  it('words a refused row replay in a toast', async () => {
    const user = userEvent.setup();
    const calls: Calls[] = [];
    await open(
      calls,
      hooks(calls, undefined, {
        [`${PATH}/deliveries/ev1/replay`]: () => problem(429, 'RATE_LIMITED', 'Slow down.'),
      }),
    );
    await user.click(await screen.findByRole('button', { name: 'Replay Scanned delivery' }));
    expect(await screen.findByText('Too many replays. Try again shortly.')).toBeVisible();
  });

  it('gives a reader no row action', async () => {
    const calls: Calls[] = [];
    await open(calls, hooks(calls, { endpoints: [endpoint({ url: null })] }), reader);
    await screen.findByRole('table', { name: 'Deliveries' });
    expect(screen.queryByRole('button', { name: /^Replay .* delivery$/ })).toBeNull();
  });

  it('clears a sheet refusal when the sheet is opened again', async () => {
    const user = userEvent.setup();
    const calls: Calls[] = [];
    await open(
      calls,
      hooks(calls, undefined, {
        [`${PATH}/deliveries/ev1/replay`]: () =>
          problem(409, 'DELIVERY_PENDING', 'This delivery is already waiting to be sent.'),
      }),
    );
    await user.click(await screen.findByRole('button', { name: /^Scanned,/ }));
    let sheet = await screen.findByRole('dialog', { name: 'Delivery' });
    await user.click(await within(sheet).findByRole('button', { name: 'Replay' }));
    expect(await within(sheet).findByText('It is already waiting to be sent.')).toBeVisible();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delivery' })).toBeNull());
    await user.click(await screen.findByRole('button', { name: /^Scanned,/ }));
    sheet = await screen.findByRole('dialog', { name: 'Delivery' });
    await within(sheet).findByText('First send: HTTP 503');
    expect(within(sheet).queryByText('It is already waiting to be sent.')).toBeNull();
  });
});

describe('bulk replay', () => {
  const openDialog = async (calls: Calls[], handlers = hooks(calls)) => {
    const user = userEvent.setup();
    await open(calls, handlers);
    await user.click(await screen.findByRole('button', { name: 'Replay' }));
    return { user, dialog: await screen.findByRole('dialog', { name: 'Replay deliveries' }) };
  };

  it('replays failed deliveries of the last 24 hours and reports the count', async () => {
    const calls: Calls[] = [];
    const { user, dialog } = await openDialog(calls);
    await user.click(within(dialog).getByRole('button', { name: /^Replay/ }));
    expect(await screen.findByText('Queued 42 deliveries.')).toBeVisible();
    const body = sent(calls, 'POST', `${PATH}/replay`)[0]?.body as {
      from: number;
      to: number;
      include: string;
      missing?: boolean;
    };
    expect(body.include).toBe('failed');
    expect(body.missing).toBeUndefined();
    expect(body.to - body.from).toBe(24 * 3_600_000);
  });

  it('sends missing: true when the box is ticked', async () => {
    const calls: Calls[] = [];
    const { user, dialog } = await openDialog(calls);
    await user.click(
      within(dialog).getByRole('checkbox', {
        name: 'Also send events from before this endpoint was added',
      }),
    );
    await user.click(within(dialog).getByRole('button', { name: /^Replay/ }));
    await waitFor(() => expect(sent(calls, 'POST', `${PATH}/replay`)).toHaveLength(1));
    expect(sent(calls, 'POST', `${PATH}/replay`)[0]?.body).toMatchObject({ missing: true });
  });

  it('shows how many deliveries match before sending', async () => {
    const calls: Calls[] = [];
    const { dialog } = await openDialog(calls);
    expect(await within(dialog).findByText('42 deliveries match.')).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Replay 42' })).toBeEnabled();
    expect(sent(calls, 'POST', `${PATH}/replay`)).toHaveLength(0);
  });

  it('disables Replay when no delivery matches', async () => {
    const calls: Calls[] = [];
    const { dialog } = await openDialog(
      calls,
      hooks(calls, undefined, { [`${PATH}/replay`]: () => json({ queued: 0 }) }),
    );
    expect(await within(dialog).findByText('No deliveries match.')).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Replay' })).toBeDisabled();
  });

  it('says so when nothing is in range', async () => {
    const calls: Calls[] = [];
    const { user, dialog } = await openDialog(
      calls,
      hooks(calls, undefined, {
        [`${PATH}/replay`]: (_u, init) =>
          json({ queued: JSON.parse(String(init?.body)).dryRun ? 5 : 0 }),
      }),
    );
    await user.click(within(dialog).getByRole('button', { name: /^Replay/ }));
    expect(await screen.findByText('Nothing to replay in that range.')).toBeVisible();
  });

  it.each([
    [
      'over the 10,000 cap',
      problem(422, 'REPLAY_TOO_LARGE', 'That range holds more than 10000 deliveries. Narrow it.'),
      'That range holds more than 10000 deliveries. Choose a shorter range.',
    ],
    [
      'over the one a minute limit',
      problem(429, 'RATE_LIMITED', 'Slow down.'),
      'Replay is limited to one a minute. Try again shortly.',
    ],
    [
      'a first chunk that failed (503)',
      problem(503, 'REPLAY_NOT_QUEUED', 'Nothing was queued. Try again.'),
      'Nothing was queued. Try again.',
    ],
  ])('keeps the dialog open and explains a refusal: %s', async (_name, response, line) => {
    const calls: Calls[] = [];
    const { user, dialog } = await openDialog(
      calls,
      hooks(calls, undefined, { [`${PATH}/replay`]: () => response.clone() }),
    );
    await user.click(within(dialog).getByRole('button', { name: /^Replay/ }));
    expect(await within(dialog).findByText(line)).toBeVisible();
    expect(screen.getByRole('dialog', { name: 'Replay deliveries' })).toBeVisible();
  });

  it('clears a refusal when the dialog is cancelled and opened again', async () => {
    const calls: Calls[] = [];
    const { user, dialog } = await openDialog(
      calls,
      hooks(calls, undefined, {
        [`${PATH}/replay`]: () => problem(429, 'RATE_LIMITED', 'Slow down.'),
      }),
    );
    await user.click(within(dialog).getByRole('button', { name: /^Replay/ }));
    await within(dialog).findByText('Replay is limited to one a minute. Try again shortly.');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(screen.getByRole('button', { name: 'Replay' }));
    const again = await screen.findByRole('dialog', { name: 'Replay deliveries' });
    expect(within(again).queryByText(/limited to one a minute/)).toBeNull();
  });

  it('opens from the Replay failed button of a disabled endpoint', async () => {
    const user = userEvent.setup();
    const calls: Calls[] = [];
    await open(calls, hooks(calls, { endpoints: [endpoint({ status: 'disabled' })] }));
    await user.click(await screen.findByRole('button', { name: 'Replay failed' }));
    expect(await screen.findByRole('dialog', { name: 'Replay deliveries' })).toBeVisible();
  });
});
