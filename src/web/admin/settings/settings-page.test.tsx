import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { json, problem, renderApp } from '@/web/lib/test-utils.tsx';
import { changedValues, ORG_FIELDS, PLATFORM_FIELDS, parseField, toDraft } from './fields.ts';

const entries = (over: Record<string, unknown> = {}, saved: string[] = []) => {
  const defaults: Record<string, unknown> = {
    'oidc.trustEmail': false,
    'auth.magicLinkEnabled': true,
    'email.senderName': 'PassBook',
    'refresh.userCooldownSeconds': 30,
    'push.budgetPerDay': 3,
    'retention.passVersionsKeep': 3,
    'retention.auditDays': 365,
    'retention.eventsDays': 90,
    'retention.scansDays': 396,
    'sandbox.purgeDays': 30,
    'scan.undoWindowMinutes': 10,
    'scan.lookupsPerHour': 200,
  };
  return {
    items: Object.entries(defaults).map(([key, value]) => ({
      scope: 'platform',
      key,
      value: over[key] ?? value,
      default: value,
      updatedAt: saved.includes(key) ? 1_700_000_000_000 : null,
      updatedBy: saved.includes(key) ? 'u1' : null,
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
    const initial = toDraft(PLATFORM_FIELDS, { 'email.senderName': 'PassBook' });
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
    expect(await screen.findByLabelText('Email sender name')).toHaveValue('PassBook');
    expect(screen.getByText('396 days')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Magic-link sign-in' })).toBeChecked();
    expect(screen.getByRole('heading', { name: 'Access and sign-in' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Polaris ID/ })).toBeInTheDocument();
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
    const link = await screen.findByRole('link', { name: 'Open Polaris ID' });
    expect(link).toHaveAttribute('href', 'https://id.staging.test');
  });

  it('confirms turning magic links off with the email-only count, then saves', async () => {
    let body: unknown;
    await renderApp('/admin/settings', {
      session: 'admin',
      handlers: {
        '/api/v1/settings/impact': () => json({ emailOnlyUsers: 12 }),
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
    expect(
      screen.getByText('After saving, holders without Polaris ID will not be able to sign in.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Turn off magic-link sign-in?' });
    expect(await within(dialog).findByText('12 users')).toBeInTheDocument();
    expect(within(dialog).getByText('Magic-link sign-in:').parentElement).toHaveTextContent(
      'On → Off',
    );
    expect(body).toBeUndefined();
    await user.click(within(dialog).getByRole('button', { name: 'Turn off' }));
    await waitFor(() =>
      expect(body).toEqual({ scope: 'platform', values: { 'auth.magicLinkEnabled': false } }),
    );
  });

  it('keeps magic links on when the confirm is cancelled', async () => {
    let puts = 0;
    await renderApp('/admin/settings', {
      session: 'admin',
      handlers: {
        '/api/v1/settings/impact': () => json({ emailOnlyUsers: 1 }),
        '/api/v1/settings': (_url, init) => {
          if (init?.method === 'PUT') puts++;
          return json(entries());
        },
      },
    });
    const user = userEvent.setup();
    const toggle = await screen.findByRole('switch', { name: 'Magic-link sign-in' });
    await user.click(toggle);
    expect(toggle).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Turn off magic-link sign-in?' });
    expect(await within(dialog).findByText('1 user')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(toggle).toBeChecked();
    expect(puts).toBe(0);
  });

  it('sets help in xs muted and the control column flush right', async () => {
    const { container } = await renderApp('/admin/settings', {
      session: 'admin',
      handlers: { '/api/v1/settings': () => json(entries()) },
    });
    await screen.findByLabelText('Email sender name');
    const help = screen.getByText('Holders can sign in with an email link.');
    expect(help).toHaveClass('text-xs', 'text-fg-muted');
    for (const p of container.querySelectorAll('form p[id$="-help"]'))
      expect(p).toHaveClass('text-xs', 'text-fg-muted');
    await userEvent.setup().click(screen.getByRole('radio', { name: 'Advanced' }));
    const cooldown = screen.getByLabelText('Refresh cooldown');
    expect(cooldown.closest('.items-end')).not.toBeNull();
    expect(cooldown.parentElement).toHaveTextContent('s');
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
    await user.click(
      within(await screen.findByRole('alertdialog', { name: 'Review platform changes' })).getByRole(
        'button',
        { name: 'Save changes' },
      ),
    );
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
    await screen.findByLabelText('Email sender name');
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: 'Advanced' }));
    const input = screen.getByLabelText('Refresh cooldown');
    await user.clear(input);
    await user.type(input, '1');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('1 field needs attention')).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(input).toHaveFocus());
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
    await user.click(
      within(await screen.findByRole('alertdialog', { name: 'Review platform changes' })).getByRole(
        'button',
        { name: 'Save changes' },
      ),
    );
    expect(await screen.findByText('Too long.')).toBeInTheDocument();
    // Refused by the server: focused like a blocked save; the next keystroke clears it.
    await waitFor(() => expect(input).toHaveFocus());
    expect(await screen.findByText('1 field needs attention')).toBeInTheDocument();
    await user.type(input, 'y');
    expect(screen.queryByText('Too long.')).toBeNull();
  });

  it('keeps advanced drafts on disclosure changes and reveals invalid hidden fields', async () => {
    let puts = 0;
    await renderApp('/admin/settings', {
      session: 'admin',
      handlers: {
        '/api/v1/settings': (_url, init) => {
          if (init?.method === 'PUT') puts++;
          return json(entries());
        },
      },
    });
    const user = userEvent.setup();
    await screen.findByLabelText('Email sender name');
    await user.click(screen.getByRole('radio', { name: 'Advanced' }));
    expect(screen.getByLabelText('Scan retention')).toHaveValue(396);
    expect(screen.getByLabelText('Scan undo window')).toHaveValue(10);
    expect(screen.getByLabelText('People lookups per hour')).toHaveValue(200);
    const cooldown = screen.getByLabelText('Refresh cooldown');
    await user.clear(cooldown);
    await user.type(cooldown, '1');
    await user.click(screen.getByRole('radio', { name: 'Basic' }));
    expect(screen.getByText('1 unsaved change in Advanced.')).toBeVisible();
    expect(cooldown).not.toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByRole('radio', { name: 'Advanced', checked: true }),
    ).toBeInTheDocument();
    await waitFor(() => expect(cooldown).toHaveFocus());
    expect(cooldown).toHaveValue(1);
    expect(puts).toBe(0);
  });

  it('reviews and persists a reset using the null reset contract', async () => {
    let body: unknown;
    await renderApp('/admin/settings', {
      session: 'admin',
      handlers: {
        '/api/v1/settings': (_url, init) => {
          if (init?.method === 'PUT') {
            body = JSON.parse(String(init.body));
            return json(entries());
          }
          return json(entries({ 'retention.auditDays': 180 }, ['retention.auditDays']));
        },
      },
    });
    const user = userEvent.setup();
    await screen.findByLabelText('Email sender name');
    await user.click(screen.getByRole('radio', { name: 'Advanced' }));
    const input = screen.getByLabelText('Audit retention');
    await user.click(screen.getByRole('button', { name: 'Reset Audit retention to default' }));
    expect(input).toHaveValue(365);
    expect(body).toBeUndefined();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const review = await screen.findByRole('alertdialog', { name: 'Review platform changes' });
    expect(
      within(review).getByText(/180 days → 365 days \(reset to default\)/),
    ).toBeInTheDocument();
    await user.click(within(review).getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(body).toEqual({ scope: 'platform', values: { 'retention.auditDays': null } }),
    );
  });

  it('clears a stored override even when its value equals the default', async () => {
    let body: unknown;
    await renderApp('/admin/settings', {
      session: 'admin',
      handlers: {
        '/api/v1/settings': (_url, init) => {
          if (init?.method === 'PUT') {
            body = JSON.parse(String(init.body));
            return json(entries());
          }
          return json(entries({}, ['retention.auditDays']));
        },
      },
    });
    const user = userEvent.setup();
    await screen.findByLabelText('Email sender name');
    await user.click(screen.getByRole('radio', { name: 'Advanced' }));
    await user.click(screen.getByRole('button', { name: 'Reset Audit retention to default' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const review = await screen.findByRole('alertdialog', { name: 'Review platform changes' });
    await user.click(within(review).getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(body).toEqual({ scope: 'platform', values: { 'retention.auditDays': null } }),
    );
  });

  it('opens and focuses an advanced field refused by the server', async () => {
    await renderApp('/admin/settings', {
      session: 'admin',
      handlers: {
        '/api/v1/settings': (_url, init) =>
          init?.method === 'PUT'
            ? problem(422, 'validation_failed', 'Invalid.', [
                { path: 'values.scan.undoWindowMinutes', message: 'Policy rejected.' },
              ])
            : json(entries()),
      },
    });
    const user = userEvent.setup();
    await screen.findByLabelText('Email sender name');
    await user.click(screen.getByRole('radio', { name: 'Advanced' }));
    const input = screen.getByLabelText('Scan undo window');
    await user.clear(input);
    await user.type(input, '11');
    await user.click(screen.getByRole('radio', { name: 'Basic' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const review = await screen.findByRole('alertdialog', { name: 'Review platform changes' });
    await user.click(within(review).getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Policy rejected.')).toBeVisible();
    expect(screen.getByRole('radio', { name: 'Advanced', checked: true })).toBeInTheDocument();
    await waitFor(() => expect(input).toHaveFocus());
    expect(input).toHaveValue(11);
  });

  it('retains a hidden draft on failed save and warns before lowering retention', async () => {
    await renderApp('/admin/settings', {
      session: 'admin',
      handlers: {
        '/api/v1/settings': (_url, init) =>
          init?.method === 'PUT' ? problem(500, 'failed', 'Could not save.') : json(entries()),
      },
    });
    const user = userEvent.setup();
    await screen.findByLabelText('Email sender name');
    await user.click(screen.getByRole('radio', { name: 'Advanced' }));
    const input = screen.getByLabelText('Audit retention');
    await user.clear(input);
    await user.type(input, '180');
    await user.click(screen.getByRole('radio', { name: 'Basic' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const review = await screen.findByRole('alertdialog', { name: 'Review platform changes' });
    expect(within(review).getByText(/Lower retention can cause older records/)).toBeInTheDocument();
    await user.click(within(review).getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Could not save');
    await user.click(screen.getByRole('radio', { name: 'Advanced' }));
    expect(input).toHaveValue(180);
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('shows an error state when loading fails', async () => {
    await renderApp('/admin/settings', {
      session: 'admin',
      handlers: { '/api/v1/settings': () => problem(500, 'x', 'x') },
    });
    expect(await screen.findAllByText('Something went wrong. Try again.')).not.toHaveLength(0);
  });
});
