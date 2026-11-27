import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetModeForTests } from '../../../lib/mode.ts';
import { json, renderApp } from '../../../lib/test-utils.tsx';
import {
  type Calls,
  delivery,
  detail,
  endpoint,
  HOUR,
  hooks,
  manager,
  NOW,
  reader,
} from './test-fixtures.ts';

const open = (path: string, calls: Calls[], handlers = hooks(calls), as = manager) =>
  renderApp(path, { session: 'admin', memberships: [as], selectedOrg: 'org1', handlers });

afterEach(() => {
  resetModeForTests();
  vi.unstubAllGlobals();
});

describe('signing on the endpoint page', () => {
  it('shows when the secret was made, never the secret, and how to verify', async () => {
    const calls: Calls[] = [];
    await open('/admin/connections/webhooks/we1?tab=signing', calls);
    await screen.findByRole('heading', { name: 'Signing' });
    const signing = screen;
    expect(signing.getByText('Secret set')).toBeVisible();
    expect(signing.queryByText(/whsec_/)).toBeNull();
    expect(signing.getByText('Verify requests')).toBeVisible();
    expect(signing.getByText(/HMAC-SHA256/)).toBeInTheDocument();
    expect(signing.getByRole('region', { name: 'Node verify snippet' })).toHaveTextContent(
      'x-passbook-signature',
    );
  });

  it('names the time an old secret still signs, only while it does', async () => {
    const calls: Calls[] = [];
    await open(
      '/admin/connections/webhooks/we1?tab=signing',
      calls,
      hooks(calls, { endpoints: [endpoint({ previousSecretExpiresAt: NOW + 24 * HOUR })] }),
    );
    expect(await screen.findByText('Old secret signs until')).toBeVisible();
  });

  it('omits the old secret line once it has expired', async () => {
    const calls: Calls[] = [];
    await open(
      '/admin/connections/webhooks/we1?tab=signing',
      calls,
      hooks(calls, { endpoints: [endpoint({ previousSecretExpiresAt: NOW - HOUR })] }),
    );
    await screen.findByText('Secret set');
    expect(screen.queryByText('Old secret signs until')).toBeNull();
  });

  it('rotates from the card and reveals the new secret once, with Copy', async () => {
    const user = userEvent.setup();
    const calls: Calls[] = [];
    await open('/admin/connections/webhooks/we1?tab=signing', calls);
    await user.click(await screen.findByRole('button', { name: 'Rotate secret' }));
    await user.click(await screen.findByRole('button', { name: 'Rotate' }));
    const dialog = await screen.findByRole('dialog', { name: 'New signing secret' });
    expect(within(dialog).getByText('Copy the secret now. It is not shown again.')).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Copy signing secret' })).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Done' })).toBeDisabled();
  });

  it('gives a reader the dates and the guide without Rotate', async () => {
    const calls: Calls[] = [];
    await open('/admin/connections/webhooks/we1?tab=signing', calls, hooks(calls), reader);
    expect(await screen.findByText('Secret set')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Rotate secret' })).toBeNull();
    expect(screen.getByText('Verify requests')).toBeVisible();
  });
});

describe('add endpoint', () => {
  it('says the signing secret is shown once', async () => {
    const calls: Calls[] = [];
    await open('/admin/connections/webhooks/new', calls);
    expect(
      await screen.findByText('https only. A signing secret is shown once after you add this.'),
    ).toBeVisible();
  });
});

describe('delivery sheet', () => {
  it('shows the request headers of the latest attempt and how to verify', async () => {
    const user = userEvent.setup();
    const calls: Calls[] = [];
    await open('/admin/connections/webhooks/we1?tab=deliveries', calls);
    await user.click(await screen.findByRole('button', { name: /^Scanned,/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Delivery' });
    const headers = await within(sheet).findByRole('region', { name: 'Request headers' });
    expect(headers).toHaveTextContent('x-passbook-event-id: ev1');
    expect(headers).toHaveTextContent('x-passbook-event-type: pass.scanned');
    expect(headers).toHaveTextContent(
      `x-passbook-timestamp: ${Math.floor((NOW - 2 * HOUR) / 1000)}`,
    );
    expect(headers).toHaveTextContent('x-passbook-signature: v1=<hex>');
    expect(within(sheet).getByText('How to verify the signature')).toBeVisible();
    expect(
      within(sheet).getByText('Response bodies are not stored. Status and time are.'),
    ).toBeVisible();
  });

  it('links the pass and says what a failed delivery needs', async () => {
    const user = userEvent.setup();
    const calls: Calls[] = [];
    await open('/admin/connections/webhooks/we1?tab=deliveries', calls);
    await user.click(await screen.findByRole('button', { name: /^Scanned,/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Delivery' });
    expect(await within(sheet).findByRole('link', { name: 'ORD-7' })).toHaveAttribute(
      'href',
      expect.stringContaining('/admin/passes/p1234567890'),
    );
    expect(
      within(sheet).getByText('Last result: HTTP 503. Fix the endpoint, then replay.'),
    ).toBeVisible();
  });

  it('explains a pending delivery on a paused endpoint in the table and the sheet', async () => {
    const user = userEvent.setup();
    const calls: Calls[] = [];
    await open(
      '/admin/connections/webhooks/we1?tab=deliveries',
      calls,
      hooks(
        calls,
        {
          endpoints: [endpoint({ status: 'paused' })],
          deliveries: [
            delivery({ state: 'pending', attempts: 0, lastAttemptAt: null, lastStatus: null }),
          ],
        },
        {
          '/api/v1/webhook-endpoints/we1/deliveries/ev1': () =>
            json(detail({ state: 'pending', attempts: 0, attemptLog: [], lastStatus: null })),
        },
      ),
    );
    const table = await screen.findByRole('table', { name: 'Deliveries' });
    expect(within(table).getByText('Last attempt')).toBeVisible();
    expect(within(table).getByText('Not sent')).toBeVisible();
    expect(within(table).getByTitle('Paused: not sent until the endpoint resumes')).toBeVisible();
    expect(within(table).getByTitle('Pending deliveries cannot be replayed')).toBeVisible();
    await user.click(within(table).getByRole('button', { name: /^Scanned,/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Delivery' });
    expect(
      await within(sheet).findByText('The endpoint is paused. Resume it to send this.'),
    ).toBeVisible();
  });
});

describe('endpoint page tabs', () => {
  it('opens on Overview, with deliveries and signing a tab away', async () => {
    const user = userEvent.setup();
    const calls: Calls[] = [];
    await open('/admin/connections/webhooks/we1', calls);
    expect(await screen.findByRole('tab', { name: 'Overview', selected: true })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Deliveries' })).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'Deliveries' }));
    expect(await screen.findByRole('heading', { name: 'Deliveries' })).toBeVisible();
    await user.click(screen.getByRole('tab', { name: 'Signing' }));
    expect(await screen.findByText('Secret set')).toBeVisible();
  });
});

describe('delivery curl', () => {
  it('copies a script that signs a fresh timestamp and posts the same body', async () => {
    const user = userEvent.setup();
    const calls: Calls[] = [];
    await open('/admin/connections/webhooks/we1?tab=deliveries', calls);
    await user.click(await screen.findByRole('button', { name: /^Scanned,/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Delivery' });
    await user.click(await within(sheet).findByText('Copy as curl'));
    const script = within(sheet).getByRole('region', { name: 'curl command' });
    expect(script).toHaveTextContent('curl -X POST "$ENDPOINT_URL"');
    expect(script).toHaveTextContent("-H 'x-passbook-event-id: ev1'");
    expect(script).toHaveTextContent('openssl dgst -sha256 -hmac "$SECRET"');
    expect(script).toHaveTextContent('"type":"pass.scanned"');
    expect(script).not.toHaveTextContent('whsec_');
  });
});

describe('settings fold', () => {
  it('starts folded on a narrow screen and opens with Show', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('max-width'),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }));
    const user = userEvent.setup();
    const calls: Calls[] = [];
    await open('/admin/connections/webhooks/we1', calls);
    await screen.findByRole('heading', { name: 'Settings' });
    expect(screen.getByLabelText(/^URL/)).not.toBeVisible();
    const toggle = screen.getByRole('button', { name: 'Show' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(await screen.findByLabelText(/^URL/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Hide' })).toHaveAttribute('aria-expanded', 'true');
  });
});
