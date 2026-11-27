import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { resetModeForTests, setMode } from '../../../lib/mode.ts';
import { problem, renderApp } from '../../../lib/test-utils.tsx';
import { type Calls, endpoint, HOUR, hooks, manager, NOW, reader } from './test-fixtures.ts';

const open = (path: string, calls: Calls[], handlers = hooks(calls), as = manager) =>
  renderApp(path, { session: 'admin', memberships: [as], selectedOrg: 'org1', handlers });

afterEach(() => resetModeForTests());

describe('webhooks tab', () => {
  it('lists endpoints with their health words', async () => {
    const calls: Calls[] = [];
    const state = {
      endpoints: [
        endpoint({ id: 'a', urlMasked: 'a.example.com/…aaaa' }),
        endpoint({ id: 'b', urlMasked: 'b.example.com/…bbbb', failingSince: NOW - 3 * HOUR }),
        endpoint({ id: 'c', urlMasked: 'c.example.com/…cccc', status: 'paused' }),
        endpoint({ id: 'd', urlMasked: 'd.example.com/…dddd', status: 'disabled' }),
      ],
    };
    await open('/admin/connections?tab=webhooks', calls, hooks(calls, state));
    const table = await screen.findByRole('table', { name: 'Webhook endpoints' });
    for (const text of ['Active', 'Failing for 3 h', 'Paused', 'Disabled'])
      expect(within(table).getByText(text)).toBeVisible();
    expect(within(table).getByRole('link', { name: 'a.example.com/…aaaa' })).toHaveAttribute(
      'href',
      expect.stringContaining('/admin/connections/webhooks/a'),
    );
    expect(screen.getByRole('link', { name: 'Add endpoint' })).toBeVisible();
    expect(within(table).getAllByText('HTTP 200').length).toBeGreaterThan(0);
    expect(calls[0]?.search).toContain('orgId=org1');
  });

  it('shows the empty state with Add endpoint for a manager', async () => {
    const calls: Calls[] = [];
    await open('/admin/connections?tab=webhooks', calls, hooks(calls, { endpoints: [] }));
    expect(await screen.findByText('No webhooks')).toBeVisible();
    expect(screen.getAllByRole('link', { name: 'Add endpoint' }).length).toBeGreaterThan(0);
  });

  it('gives a reader the list without an Add button', async () => {
    const calls: Calls[] = [];
    await open('/admin/connections?tab=webhooks', calls, hooks(calls, { endpoints: [] }), reader);
    expect(await screen.findByText('No webhooks')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Add endpoint' })).toBeNull();
  });

  it('says that Test endpoints get test events only', async () => {
    setMode('test');
    const calls: Calls[] = [];
    await open('/admin/connections?tab=webhooks', calls);
    expect(await screen.findByText('Test endpoints get test events only.')).toBeVisible();
  });

  it('shows an error with Retry when the list fails', async () => {
    const calls: Calls[] = [];
    await open(
      '/admin/connections?tab=webhooks',
      calls,
      hooks(calls, undefined, {
        '/api/v1/webhook-endpoints': () => problem(500, 'internal', 'Boom'),
      }),
    );
    expect(await screen.findByRole('button', { name: /retry|try again/i })).toBeVisible();
  });

  it('switches between Sources and Webhooks', async () => {
    const calls: Calls[] = [];
    await open('/admin/connections', calls);
    expect(await screen.findByRole('tab', { name: 'Sources', selected: true })).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Webhook endpoints' })).toBeVisible(),
    );
  });
});

describe('endpoint detail for a reader', () => {
  it('shows the masked URL, read-only, and no actions', async () => {
    const calls: Calls[] = [];
    const state = { endpoints: [endpoint({ url: null })] };
    await open('/admin/connections/webhooks/we1', calls, hooks(calls, state), reader);
    const url = await screen.findByRole('textbox', { name: /URL/ });
    expect(url).toHaveValue('hooks.example.com/…1234');
    expect(url).toHaveAttribute('readonly');
    expect(screen.queryByRole('button', { name: 'Send test' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Replay' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Deliveries' })).toBeVisible();
  });

  it('shows the disabled callout with Resume and Replay failed', async () => {
    const calls: Calls[] = [];
    const state = {
      endpoints: [
        endpoint({
          status: 'disabled',
          failingSince: NOW - 80 * HOUR,
          disabledAt: NOW - HOUR,
        }),
      ],
    };
    await open('/admin/connections/webhooks/we1', calls, hooks(calls, state));
    expect(await screen.findByText(/Disabled after 3 days of failed deliveries/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Replay failed' })).toBeVisible();
  });

  it('answers 404 with the not found state', async () => {
    const calls: Calls[] = [];
    await open(
      '/admin/connections/webhooks/we1',
      calls,
      hooks(calls, undefined, {
        '/api/v1/webhook-endpoints/we1': () => problem(404, 'not_found', 'Not found.'),
      }),
    );
    expect(await screen.findByText(/not found/i)).toBeVisible();
  });
});
