import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RecipeId } from '@/shared/contracts/connections.ts';
import { json, membershipFixture, renderApp } from '../../lib/test-utils.tsx';
import { inboundTrouble } from '../../ui/webhook-setup/index.ts';
import { setViewport } from '../../ui/webhook-setup/test-support.test-support.tsx';
import type { Arrival } from '../../ui/webhook-setup/types.ts';
import { ORG } from '../passes/test-fixtures.ts';
import { GUIDES, ledgerRow, RECIPE_IDS, setupHandlers, setupOf, URL_C9 } from './setup-fixtures.ts';
import { holdSecret } from './setup-handoff.ts';

const membership = membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug });
const strip = (text: string) => text.replace(/\*\*|`/g, '');

function open(recipe: RecipeId, opts: Parameters<typeof setupHandlers>[1] = {}) {
  return renderApp('/admin/connections/c9/setup', {
    session: 'admin',
    memberships: [membership],
    selectedOrg: ORG.id,
    handlers: setupHandlers(recipe, opts),
  });
}

const REJECTED = [
  'signature_missing',
  'signature_mismatch',
  'signature_expired',
  'payload',
  'too_large',
  'no_secret',
] as const;
const IGNORED = [
  'unknown_type',
  'thin_event',
  'test_mode',
  'unrecognized_shape',
  'no_ref',
] as const;
const ALL_REASONS = [...REJECTED, ...IGNORED];
const asRow = (reason: string) =>
  ledgerRow({
    outcome: (REJECTED as readonly string[]).includes(reason) ? 'rejected' : 'ignored',
    reason,
    topic: reason === 'unknown_type' ? 'other' : null,
  });

beforeEach(() => setViewport(1440));

describe.each(RECIPE_IDS)('setup page: %s', (recipe) => {
  const guide = GUIDES[recipe];
  const provider = guide.provider.name;

  it('a signed delivery shows the catch, and Done finishes', async () => {
    const user = userEvent.setup();
    await open(recipe, { rows: [ledgerRow({ topic: guide.subscriptions.topics[0]?.id ?? null })] });
    expect(
      await screen.findByRole('heading', { name: 'Signed delivery seen', level: 4 }),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByRole('heading', { name: `${provider} is connected` })).toBeVisible();
    expect(screen.getByText('Signature OK')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Open connection' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Set up another' })).toBeVisible();
  });

  it('a sample counts as a pass and says nothing was issued', async () => {
    await open(recipe, { rows: [ledgerRow({ outcome: 'ignored', reason: 'stale', topic: null })] });
    expect(
      await screen.findByText('Samples prove the setup. Real orders issue passes.'),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Done' })).not.toHaveAttribute('aria-disabled');
  });

  it('waits, without Done, while nothing has arrived', async () => {
    await open(recipe);
    expect(
      await screen.findByRole('heading', { name: 'Listening · nothing yet', level: 4 }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Done' })).toHaveAttribute('aria-disabled', 'true');
    expect(document.body.textContent).toContain(strip(guide.test.text));
  });
});

describe('setup page: every reason shows its fix', () => {
  const cases: [RecipeId, string][] = [
    ...ALL_REASONS.flatMap((r): [RecipeId, string][] => [
      ['shopify-orders', r],
      ['custom', r],
    ]),
    ...RECIPE_IDS.filter((id) => id !== 'shopify-orders' && id !== 'custom').flatMap(
      (id): [RecipeId, string][] =>
        Object.keys(GUIDES[id].troubleshooting)
          .filter((k) => (ALL_REASONS as readonly string[]).includes(k))
          .map((k): [RecipeId, string] => [id, k]),
    ),
  ];
  it.each(cases)('%s: %s', async (recipe, reason) => {
    const guide = GUIDES[recipe];
    const row = asRow(reason);
    await open(recipe, { rows: [row] });
    const trouble = inboundTrouble(row as unknown as Arrival, {
      provider: guide.provider.name,
      origin: guide.secret.origin,
      recipeFix: guide.troubleshooting,
    });
    await waitFor(() => expect(document.body.textContent).toContain(strip(trouble.fix)));
    expect(screen.getAllByText(trouble.title).length).toBeGreaterThan(0);
    // A guide's own line wins over the generic one.
    const own = guide.troubleshooting[reason];
    if (own) expect(trouble.fix).toBe(own);
  });
});

describe('setup page: where it resumes', () => {
  it('opens at Connect when the sender has not given a secret yet', async () => {
    await open('shopify-orders', { values: { hasSecret: false } });
    expect(await screen.findByRole('heading', { name: 'Add the webhook', level: 2 })).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'Copy endpoint URL' }).length).toBeGreaterThan(0);
    // The guide says when it was last checked: month and year, no weekday.
    expect(screen.getByText('Checked Nov 2026')).toBeVisible();
    expect(screen.getByRole('group', { name: 'In PassBook' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'In Shopify' })).toBeInTheDocument();
    expect(document.querySelectorAll('[data-locked]')).toHaveLength(5);
  });

  it('opens at Test when the secret is saved and nothing verified has arrived', async () => {
    await open('shopify-orders');
    expect(await screen.findByRole('heading', { name: 'Send a test', level: 2 })).toBeVisible();
  });

  it('pastes the sender secret, checks its look, saves it and moves to Test', async () => {
    const user = userEvent.setup();
    const patches: Record<string, unknown>[] = [];
    await open('stripe-payments', { values: { hasSecret: false }, patches });
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    expect(
      await screen.findByRole('heading', { name: 'Paste the secret', level: 2 }),
    ).toBeVisible();
    const field = screen.getByLabelText(/Signing secret/);
    await user.type(field, 'secret-without-prefix');
    expect(screen.getByText('A Stripe signing secret starts with whsec_.')).toBeVisible();
    await user.clear(field);
    await user.type(field, 'whsec_demo_demo_demo');
    await user.click(screen.getByRole('button', { name: 'Save secret' }));
    await waitFor(() =>
      expect(patches[0]).toMatchObject({ webhookSecret: 'whsec_demo_demo_demo' }),
    );
    expect(await screen.findByRole('heading', { name: 'Send a test', level: 2 })).toBeVisible();
  });

  it('Replace secret on a refused signature goes back to the Secret step', async () => {
    const user = userEvent.setup();
    await open('shopify-orders', { rows: [asRow('signature_mismatch')] });
    await user.click(await screen.findByRole('button', { name: 'Replace secret' }));
    expect(
      await screen.findByRole('heading', { name: 'Paste the secret', level: 2 }),
    ).toBeVisible();
    expect(screen.getByLabelText(/Signing secret/)).toBeVisible();
  });

  it('Turn on changes the connection to take sandbox events', async () => {
    const user = userEvent.setup();
    const patches: Record<string, unknown>[] = [];
    await open('stripe-payments', { rows: [asRow('test_mode')], patches });
    await user.click(await screen.findByRole('button', { name: 'Turn on' }));
    await waitFor(() =>
      expect(patches[0]).toMatchObject({
        config: { recipe: 'stripe-payments', acceptTestEvents: true },
      }),
    );
  });

  it('shows PassBook’s own secret once, before Connect, and keeps it off the page after', async () => {
    const user = userEvent.setup();
    holdSecret('c9', 'f'.repeat(64));
    await open('calcom-bookings', { values: { hasSecret: true } });
    expect(await screen.findByRole('heading', { name: 'Copy the secret', level: 2 })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Copy signing secret' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Next' })).toHaveAttribute('aria-disabled', 'true');
    await user.click(screen.getByRole('checkbox', { name: 'I saved the secret' }));
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByRole('heading', { name: 'Add the webhook', level: 2 })).toBeVisible();
    expect(document.body.textContent).not.toContain('f'.repeat(64));
  });

  it('offers a new secret when the first one was not kept', async () => {
    const user = userEvent.setup();
    const patches: Record<string, unknown>[] = [];
    await open('woocommerce-orders', { patches });
    await user.click(await screen.findByRole('button', { name: 'Back' }));
    await user.click(await screen.findByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('heading', { name: 'Copy the secret', level: 2 })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'New secret' }));
    await waitFor(() => expect(patches[0]?.webhookSecret).toMatch(/^[0-9a-f]{64}$/));
    expect(patches[0]?.overlapSeconds).toBe(86_400);
    expect(await screen.findByRole('button', { name: 'Copy signing secret' })).toBeVisible();
  });
});

describe('setup page: the custom path', () => {
  it('draws the send snippets with its URL, headers and the payload shape set in Setup', async () => {
    const user = userEvent.setup();
    await open('custom', { detail: { config: { recordsPointer: '/items' } } });
    await user.click(await screen.findByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('heading', { name: 'Add the webhook', level: 2 })).toBeVisible();
    const snippet = (await screen.findByText(/openssl dgst/)).textContent ?? '';
    expect(snippet).toContain(URL_C9);
    expect(snippet).toContain('x-passbook-signature');
    expect(snippet).toContain('"items":[');
    expect(snippet).not.toMatch(/[0-9a-f]{64}/);
    await user.click(screen.getByRole('tab', { name: 'Node' }));
    expect(await screen.findByText(/createHmac/)).toBeVisible();
    expect(setupOf('custom').values.hasSecret).toBe(true);
  });
});

describe('setup page: leaving', () => {
  it('Cancel asks first, Keep setting up stays, Leave goes to the connection and deletes nothing', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    const handlers = setupHandlers('shopify-orders');
    const detail = handlers['/api/v1/connections/c9'];
    const { router } = await renderApp('/admin/connections/c9/setup', {
      session: 'admin',
      memberships: [membership],
      selectedOrg: ORG.id,
      handlers: {
        ...handlers,
        '/api/v1/connections/c9': (u, init) => {
          calls.push((init?.method ?? 'GET').toUpperCase());
          return detail ? detail(u, init) : json({});
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Leave setup?' });
    expect(within(dialog).getByText('The connection stays, waiting for Shopify.')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Keep setting up' }));
    expect(router.state.location.pathname).toMatch(/\/connections\/c9\/setup$/);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Leave' }),
    );
    await waitFor(() => expect(router.state.location.pathname).toMatch(/\/connections\/c9$/));
    expect(calls).not.toContain('DELETE');
  });
});
