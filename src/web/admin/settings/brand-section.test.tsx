import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { json, membershipFixture, renderApp } from '@/web/lib/test-utils.tsx';

const org = {
  id: 'o1',
  slug: 'acme',
  name: 'Acme Gym',
  status: 'active',
  defaultIdentityId: null,
  branding: {},
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  counts: { passes: 0, templates: 0, connections: 0, apiKeys: 0 },
  countsCapped: false,
};
const kit = {
  orgId: 'o1',
  name: 'Acme Gym',
  accent: null,
  webLogo: null,
  supportEmail: null,
  supportUrl: null,
  mark: 'full',
  markChosen: 'full',
  markAllowed: ['full', 'small'],
  configRevision: 4,
};

function setup(over: Record<string, unknown> = {}, onPatch?: (body: unknown) => void) {
  return renderApp('/admin/o/o1/settings', {
    session: 'admin',
    memberships: [membershipFixture('o1')],
    handlers: {
      '/api/v1/orgs/o1': () => json(org),
      '/api/v1/orgs/o1/workspace': () => json(org),
      '/api/v1/orgs/o1/memberships': () => json({ items: [] }),
      '/api/v1/orgs/o1/invitations': () => json({ items: [] }),
      '/api/v1/wallet-providers/accounts': () => json({ items: [] }),
      '/api/v1/identities': () => json({ items: [], nextCursor: null }),
      '/api/v1/settings': () => json({ items: [] }),
      '/api/v1/brand': (_url, init) => {
        if (init?.method === 'PATCH') {
          onPatch?.(JSON.parse(String(init.body)));
          return json(org);
        }
        return json({ ...kit, ...over });
      },
    },
  });
}

describe('Brand section', () => {
  it('offers the mark levels the org may use and disables the rest', async () => {
    await setup();
    expect(await screen.findByRole('radio', { name: /Full/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Small/ })).toBeEnabled();
    expect(screen.getByRole('radio', { name: /None/ })).toBeDisabled();
    expect(screen.getByText('Not available for this organization.')).toBeInTheDocument();
  });

  it('shows the uploaded web logo with Replace and Remove', async () => {
    await setup({ webLogo: { url: `/brand/o1/${'a'.repeat(64)}.png`, w: 400, h: 100 } });
    expect(await screen.findByRole('img', { name: 'Acme Gym web logo' })).toHaveAttribute(
      'src',
      `/brand/o1/${'a'.repeat(64)}.png`,
    );
    expect(screen.getByRole('button', { name: 'Replace web logo' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove web logo' })).toBeInTheDocument();
  });

  it('saves the accent and mark with the revision it loaded', async () => {
    const bodies: unknown[] = [];
    await setup({}, (b) => bodies.push(b));
    const user = userEvent.setup();
    const save = await screen.findByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: /Small/ }));
    await user.type(screen.getByLabelText('Accent'), '#b4232c');
    await user.click(save);
    await waitFor(() =>
      expect(bodies).toEqual([{ accent: '#b4232c', mark: 'small', configRevision: 4 }]),
    );
  });

  it('warns where the accent would be too faint to see', async () => {
    await setup({ accent: '#10131c' });
    expect(await screen.findByText(/On dark pages the accent is/)).toBeInTheDocument();
  });

  it('refuses a value that is not a hex colour', async () => {
    await setup();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Accent'), 'red');
    expect(await screen.findByText('Use a hex colour like #0f766e.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});
