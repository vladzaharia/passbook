import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { json, problem, renderApp } from '@/web/lib/test-utils.tsx';
import { changedValues, ORG_FIELDS, PLATFORM_FIELDS, parseField, toDraft } from './fields.ts';

const entries = (over: Record<string, unknown> = {}) => {
  const base: Record<string, unknown> = {
    'oidc.trustEmail': true,
    'auth.magicLinkEnabled': true,
    'email.senderName': 'Wallet',
    'refresh.userCooldownSeconds': 30,
    'retention.passVersionsKeep': 3,
    'retention.auditDays': 365,
    ...over,
  };
  return {
    items: Object.entries(base).map(([key, value]) => ({
      scope: 'platform',
      key,
      value,
      updatedAt: null,
      updatedBy: null,
    })),
    oidc: { issuer: 'https://id.plrs.im', adminGroup: 'wallet-admins', userGroup: null },
  };
};

describe('field parsing', () => {
  const cooldown = PLATFORM_FIELDS.find((f) => f.key === 'refresh.userCooldownSeconds')!;
  it('validates ranges and whole numbers', () => {
    expect(parseField(cooldown, '2').error).toBeTruthy();
    expect(parseField(cooldown, '4.5').error).toBe('Enter a whole number.');
    expect(parseField(cooldown, '60').value).toBe(60);
    expect(parseField(cooldown, '').error).toBe('Required.');
  });
  it('clears optional org settings with null and checks the accent', () => {
    const accent = ORG_FIELDS.find((f) => f.key === 'branding.accent')!;
    expect(parseField(accent, '').value).toBeNull();
    expect(parseField(accent, 'teal').error).toMatch(/hex/);
    expect(parseField(accent, '#0f766e').value).toBe('#0f766e');
  });
  it('sends only changed keys', () => {
    const initial = toDraft(PLATFORM_FIELDS, { 'email.senderName': 'Wallet' });
    const draft = { ...initial, 'email.senderName': 'Acme' };
    expect(changedValues(PLATFORM_FIELDS, draft, initial).values).toEqual({
      'email.senderName': 'Acme',
    });
  });
});

describe('settings page', () => {
  it('renders values, is accessible, and shows the read-only OIDC block', async () => {
    const { container } = await renderApp('/admin/settings', {
      session: 'admin',
      handlers: { '/api/v1/settings': () => json(entries()) },
    });
    expect(await screen.findByLabelText('Email sender name')).toHaveValue('Wallet');
    expect(screen.getByLabelText('Refresh cooldown')).toHaveValue('30');
    expect(screen.getByRole('switch', { name: 'Magic-link sign-in' })).toBeChecked();
    expect(screen.getByRole('region', { name: 'Sign-in' })).toBeInTheDocument();
    expect(await screen.findByText('wallet-admins')).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('links to the configured issuer', async () => {
    await renderApp('/admin/settings', {
      session: 'admin',
      handlers: {
        '/api/v1/settings': () =>
          json({
            ...entries(),
            oidc: { issuer: 'https://id.staging.test', adminGroup: null, userGroup: null },
          }),
      },
    });
    const link = await screen.findByRole('link', { name: 'Polaris ID' });
    expect(link).toHaveAttribute('href', 'https://id.staging.test');
  });

  it('toggles a switch and saves the boolean', async () => {
    let body: unknown;
    await renderApp('/admin/settings', {
      session: 'admin',
      handlers: {
        '/api/v1/settings': (_url, init) => {
          if (init?.method === 'PUT') {
            body = JSON.parse(String(init.body));
            return json(entries({ 'auth.magicLinkEnabled': false }));
          }
          return json(entries());
        },
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('switch', { name: 'Magic-link sign-in' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(body).toEqual({ scope: 'platform', values: { 'auth.magicLinkEnabled': false } }),
    );
  });

  it('saves only the changed value and clears the dirty bar', async () => {
    let body: unknown;
    await renderApp('/admin/settings', {
      session: 'admin',
      handlers: {
        '/api/v1/settings': (_url, init) => {
          if (init?.method === 'PUT') {
            body = JSON.parse(String(init.body));
            return json(entries({ 'email.senderName': 'Acme' }));
          }
          return json(entries());
        },
      },
    });
    const input = await screen.findByLabelText('Email sender name');
    const user = userEvent.setup();
    await user.clear(input);
    await user.type(input, 'Acme');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(body).toEqual({ scope: 'platform', values: { 'email.senderName': 'Acme' } }),
    );
    await waitFor(() => expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument());
  });

  it('blocks an invalid value without calling the API', async () => {
    let puts = 0;
    await renderApp('/admin/settings', {
      session: 'admin',
      handlers: {
        '/api/v1/settings': (_u, init) => {
          if (init?.method === 'PUT') puts++;
          return json(entries());
        },
      },
    });
    const input = await screen.findByLabelText('Refresh cooldown');
    const user = userEvent.setup();
    await user.clear(input);
    await user.type(input, '1');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(puts).toBe(0);
  });

  it('shows a server field error under the field', async () => {
    await renderApp('/admin/settings', {
      session: 'admin',
      handlers: {
        '/api/v1/settings': (_u, init) =>
          init?.method === 'PUT'
            ? problem(422, 'validation_failed', 'Invalid.', [
                { path: 'values.email.senderName', message: 'Too long.' },
              ])
            : json(entries()),
      },
    });
    const input = await screen.findByLabelText('Email sender name');
    const user = userEvent.setup();
    await user.type(input, 'x');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Too long.')).toBeInTheDocument();
  });

  it('shows an error state when loading fails', async () => {
    await renderApp('/admin/settings', {
      session: 'admin',
      handlers: { '/api/v1/settings': () => problem(500, 'x', 'x') },
    });
    expect(await screen.findAllByText('Server error. Try again.')).not.toHaveLength(0);
  });
});
