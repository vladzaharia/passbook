import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { json, problem, renderApp } from '@/web/lib/test-utils.tsx';
import { remainingDays } from './expiry.tsx';
import { type UploadDraft, validateUpload } from './upload-input.ts';

const DAY = 86_400_000;
const identity = (over: Record<string, unknown> = {}) => ({
  id: 'i1',
  orgId: null,
  label: 'Platform',
  passTypeIdentifier: 'pass.im.plrs.wallet',
  teamIdentifier: 'TEAM123',
  source: 'db',
  certSha256: 'ab12',
  certSubject: 'Pass Type ID: pass.im.plrs.wallet',
  certSerial: '01',
  notBefore: 1_600_000_000_000,
  notAfter: Date.now() + 100.5 * DAY,
  daysRemaining: 100,
  apnsBinding: 'APNS',
  apnsAvailable: true,
  pushMethod: 'certificate',
  pushKey: null,
  apnsHealth: 'healthy',
  nfcEnabled: false,
  isDefault: true,
  createdAt: 1_600_000_000_000,
  ...over,
});

const draft = (over: Partial<UploadDraft> = {}): UploadDraft => ({
  mode: 'pem',
  label: 'Acme',
  certificatePem: '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----',
  privateKeyPem: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
  p12: undefined,
  p12Password: '',
  ...over,
});

describe('validateUpload', () => {
  it('accepts valid PEM input', () => {
    expect(validateUpload(draft())).toEqual({});
  });
  it('explains each PEM problem', () => {
    expect(validateUpload(draft({ label: ' ' })).label).toBe('Required.');
    expect(validateUpload(draft({ certificatePem: 'hello' })).certificatePem).toMatch(
      /BEGIN CERTIFICATE/,
    );
    expect(
      validateUpload(draft({ privateKeyPem: '-----BEGIN ENCRYPTED PRIVATE KEY-----\nx' }))
        .privateKeyPem,
    ).toMatch(/Encrypted/);
    expect(validateUpload(draft({ privateKeyPem: 'nope' })).privateKeyPem).toMatch(
      /BEGIN PRIVATE KEY/,
    );
    expect(validateUpload(draft({ certificatePem: '', privateKeyPem: '' }))).toMatchObject({
      certificatePem: 'Required.',
      privateKeyPem: 'Required.',
    });
  });
  it('checks the .p12 file', () => {
    expect(validateUpload(draft({ mode: 'p12' })).p12).toBe('Choose a .p12 file.');
    const big = new File([new Uint8Array(75_001)], 'a.p12');
    expect(validateUpload(draft({ mode: 'p12', p12: big })).p12).toMatch(/too large/);
    expect(
      validateUpload(draft({ mode: 'p12', p12: new File([new Uint8Array(10)], 'a.p12') })),
    ).toEqual({});
  });
});

describe('remainingDays', () => {
  it('prefers notAfter over the server count', () => {
    expect(remainingDays({ notAfter: 10 * DAY, daysRemaining: 99 }, 0)).toBe(10);
    expect(remainingDays({ notAfter: null, daysRemaining: 7 }, 0)).toBe(7);
    expect(remainingDays({ notAfter: 0, daysRemaining: null }, 2 * DAY)).toBe(-2);
  });
});

describe('identities list', () => {
  it('shows expiry countdown and APNs health, accessible', async () => {
    const { container } = await renderApp('/admin/identities', {
      session: 'admin',
      handlers: {
        '/api/v1/identities': () =>
          json({
            items: [
              identity(),
              identity({
                id: 'i2',
                label: 'Acme',
                isDefault: false,
                notAfter: Date.now() + 4.5 * DAY,
                apnsAvailable: false,
                pushMethod: 'none',
                apnsBinding: null,
                apnsHealth: 'unknown',
              }),
              identity({
                id: 'i3',
                label: 'Old',
                isDefault: false,
                notAfter: Date.now() - 2.5 * DAY,
                apnsHealth: 'failing',
              }),
            ],
            nextCursor: null,
          }),
      },
    });
    expect(await screen.findByText('100 days left')).toBeInTheDocument();
    expect(screen.getByText('4 days left')).toBeInTheDocument();
    expect(screen.getByText('Expired 3 days ago')).toBeInTheDocument();
    expect(screen.getAllByText('Not set up').length).toBeGreaterThan(0);
    expect(screen.getByText('Healthy')).toBeInTheDocument();
    expect(screen.getByText('Failing')).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('shows the certificate empty state and the certificate drop in the upload dialog', async () => {
    const { container } = await renderApp('/admin/identities', {
      session: 'admin',
      handlers: { '/api/v1/identities': () => json({ items: [], nextCursor: null }) },
    });
    expect(await screen.findByText('No identities')).toBeInTheDocument();
    expect(container.querySelector('[data-art="certificate"]')).not.toBeNull();
    const ui = userEvent.setup();
    await ui.click(screen.getAllByRole('button', { name: 'Upload' })[1] as HTMLElement);
    const dialog = await screen.findByRole('dialog');
    await ui.click(within(dialog).getByLabelText('.p12 file'));
    expect(dialog.querySelector('[data-art="certificate"]')).not.toBeNull();
  });

  it('shows an error', async () => {
    await renderApp('/admin/identities', {
      session: 'admin',
      handlers: { '/api/v1/identities': () => problem(500, 'x', 'x') },
    });
    expect(await screen.findByText('Something went wrong. Try again.')).toBeInTheDocument();
  });

  it('validates before upload and shows the server error', async () => {
    let posted = 0;
    await renderApp('/admin/identities', {
      session: 'admin',
      handlers: {
        '/api/v1/identities': (_u, init) => {
          if (init?.method === 'POST') {
            posted++;
            return problem(422, 'invalid_certificate', 'Certificate and key do not match.', [
              { path: 'privateKeyPem', message: 'Key does not match the certificate.' },
            ]);
          }
          return json({ items: [], nextCursor: null });
        },
      },
    });
    const ui = userEvent.setup();
    await ui.click((await screen.findAllByRole('button', { name: 'Upload' }))[0]!);
    const dialog = await screen.findByRole('dialog');
    await ui.click(within(dialog).getByRole('button', { name: 'Upload' }));
    expect(await within(dialog).findByText('Choose a .p12 file.')).toBeInTheDocument();
    // Label and file: the first is focused and the count announced.
    expect(dialog.querySelector('input[type="file"]')).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(within(dialog).getByLabelText(/Label/)).toHaveFocus());
    expect(await within(dialog).findByText('2 fields need attention')).toBeInTheDocument();
    expect(posted).toBe(0);

    await ui.click(within(dialog).getByRole('radio', { name: 'PEM certificate and key' }));
    await ui.type(within(dialog).getByLabelText(/Label/), 'Acme');
    await ui.click(within(dialog).getByLabelText('Certificate (PEM)'));
    await ui.paste('-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----');
    await ui.click(within(dialog).getByLabelText('Private key (PEM)'));
    await ui.paste('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----');
    await ui.click(within(dialog).getByRole('button', { name: 'Upload' }));
    expect(
      await within(dialog).findByText('Key does not match the certificate.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('Certificate and key do not match.')).toBeInTheDocument();
    expect(posted).toBe(1);
  });
});

describe('identity detail', () => {
  it('shows APNs instructions when the binding is missing', async () => {
    const { container } = await renderApp('/admin/identities/i1', {
      session: 'admin',
      handlers: {
        '/api/v1/identities/i1': () =>
          json(
            identity({
              apnsAvailable: false,
              pushMethod: 'none',
              apnsBinding: null,
              apnsHealth: 'unknown',
              source: 'env',
            }),
          ),
      },
    });
    expect(await screen.findByText('Push')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add push key' })).toBeInTheDocument();
    expect(screen.getByText(/mtls-certificate upload/)).toBeInTheDocument();
    expect(screen.getAllByText('Not set up').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Check' })).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'More' }));
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument();
    await userEvent.setup().keyboard('{Escape}');
    expect((await axe(container)).violations).toEqual([]);
  });

  it('adds a push key from a .p8 file and fills the key ID from its name', async () => {
    let body: Record<string, unknown> | undefined;
    const none = identity({ apnsAvailable: false, apnsBinding: null, pushMethod: 'none' });
    await renderApp('/admin/identities/i1', {
      session: 'admin',
      handlers: {
        '/api/v1/identities/i1/push-key': (_u, init) => {
          body = JSON.parse(String(init?.body));
          return json(none);
        },
        '/api/v1/identities/i1': () => json(none),
      },
    });
    const ui = userEvent.setup();
    await ui.click(await screen.findByRole('button', { name: 'Add push key' }));
    const dialog = await screen.findByRole('dialog');
    await ui.click(within(dialog).getByRole('button', { name: 'Add key' }));
    expect(await within(dialog).findByText('Choose a .p8 file.')).toBeInTheDocument();
    const file = new File(
      ['-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----'],
      'AuthKey_AB12CD34EF.p8',
    );
    await ui.upload(dialog.querySelector('input[type=file]') as HTMLInputElement, file);
    expect(within(dialog).getByLabelText(/Key ID/)).toHaveValue('AB12CD34EF');
    await ui.click(within(dialog).getByRole('button', { name: 'Add key' }));
    await waitFor(() => expect(body).toMatchObject({ keyId: 'AB12CD34EF' }));
    expect(String(body?.p8)).toContain('BEGIN PRIVATE KEY');
  });

  it('shows the push key and removes it after confirming', async () => {
    let removed = 0;
    const keyed = identity({
      apnsBinding: null,
      pushMethod: 'key',
      pushKey: {
        keyId: 'AB12CD34EF',
        createdAt: 1_600_000_000_000,
        rotatedAt: null,
        identityCount: 2,
        dependentCount: 2,
      },
    });
    const { container } = await renderApp('/admin/identities/i1', {
      session: 'admin',
      handlers: {
        '/api/v1/identities/i1/push-key': (_u, init) => {
          if (init?.method === 'DELETE') removed++;
          return json(identity({ apnsAvailable: false, apnsBinding: null, pushMethod: 'none' }));
        },
        '/api/v1/identities/i1': () => json(keyed),
      },
    });
    const ui = userEvent.setup();
    expect(await screen.findByText('AB12CD34EF')).toBeInTheDocument();
    expect(screen.getAllByText('Push key').length).toBeGreaterThan(0);
    expect(screen.getByText('TEAM123, 2 identities')).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
    await ui.click(screen.getByRole('button', { name: 'Remove key' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/2 identities of team TEAM123 lose push/)).toBeInTheDocument();
    await ui.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(removed).toBe(1));
  });

  it('saves edits with a null binding when cleared', async () => {
    let body: unknown;
    await renderApp('/admin/identities/i1', {
      session: 'admin',
      handlers: {
        '/api/v1/identities/i1': (_u, init) => {
          if (init?.method === 'PATCH') {
            body = JSON.parse(String(init.body));
            return json(identity({ label: 'Renamed', apnsBinding: null }));
          }
          return json(identity());
        },
      },
    });
    const ui = userEvent.setup();
    const label = await screen.findByLabelText(/Label/);
    await ui.clear(label);
    await ui.type(label, 'Renamed');
    await ui.clear(screen.getByLabelText('APNs binding'));
    await ui.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(body).toEqual({
        label: 'Renamed',
        nfcEnabled: false,
        isDefault: true,
        apnsBinding: null,
      }),
    );
  });

  it('omits the binding when saving an env identity', async () => {
    let body: Record<string, unknown> | undefined;
    await renderApp('/admin/identities/i1', {
      session: 'admin',
      handlers: {
        '/api/v1/identities/i1': (_u, init) => {
          if (init?.method === 'PATCH') {
            body = JSON.parse(String(init.body));
            return json(identity({ source: 'env', nfcEnabled: true }));
          }
          return json(identity({ source: 'env' }));
        },
      },
    });
    const ui = userEvent.setup();
    expect(screen.queryByLabelText('APNs binding')).not.toBeInTheDocument();
    expect(await screen.findByText('Set in the environment')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Default identity' })).toBeDisabled();
    await ui.click(screen.getByRole('switch', { name: 'NFC' }));
    await ui.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(body).toBeDefined());
    expect(body).toEqual({ label: 'Platform', nfcEnabled: true, isDefault: true });
  });

  it('deletes after confirmation and replaces the page in history', async () => {
    let deleted = false;
    const { router } = await renderApp('/admin/identities/i1', {
      session: 'admin',
      handlers: {
        '/api/v1/identities': () => json({ items: [], nextCursor: null }),
        '/api/v1/identities/i1': (_u, init) => {
          if (init?.method === 'DELETE') {
            deleted = true;
            return json({ ok: true });
          }
          return json(identity());
        },
      },
    });
    const ui = userEvent.setup();
    await ui.click(await screen.findByRole('button', { name: 'More' }));
    await ui.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    expect(deleted).toBe(false);
    await ui.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
    );
    await waitFor(() => expect(deleted).toBe(true));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/identities'));
    expect(router.history.length).toBe(1);
  });

  it('opens a new upload on its page with the next steps', async () => {
    const { router } = await renderApp('/admin/identities', {
      session: 'admin',
      handlers: {
        '/api/v1/identities': (_u, init) =>
          init?.method === 'POST'
            ? json(identity({ id: 'i9', label: 'Acme', isDefault: false }), 201)
            : json({ items: [], nextCursor: null }),
        '/api/v1/identities/i9': () =>
          json(identity({ id: 'i9', label: 'Acme', isDefault: false })),
      },
    });
    const ui = userEvent.setup();
    await ui.click((await screen.findAllByRole('button', { name: 'Upload' }))[0]!);
    const dialog = await screen.findByRole('dialog');
    await ui.click(within(dialog).getByRole('radio', { name: 'PEM certificate and key' }));
    await ui.type(within(dialog).getByLabelText(/Label/), 'Acme');
    await ui.click(within(dialog).getByLabelText('Certificate (PEM)'));
    await ui.paste('-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----');
    await ui.click(within(dialog).getByLabelText('Private key (PEM)'));
    await ui.paste('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----');
    await ui.click(within(dialog).getByRole('button', { name: 'Upload' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/identities/i9'));
    expect(await screen.findByText('Identity uploaded')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Use in an organization' })).toHaveAttribute(
      'href',
      '/admin/orgs',
    );
    await ui.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Identity uploaded')).toBeNull();
  });

  it('re-signs all passes of the identity after confirmation', async () => {
    let body: unknown;
    await renderApp('/admin/identities/i1', {
      session: 'admin',
      handlers: {
        '/api/v1/identities/i1': () => json(identity({ passCount: 45 })),
        '/api/v1/passes/bulk-reissue': (_u, init) => {
          body = JSON.parse(String(init?.body));
          return json({ workflowInstanceId: 'bulk-1' });
        },
      },
    });
    const ui = userEvent.setup();
    await ui.click(await screen.findByRole('button', { name: 'More' }));
    await ui.click(await screen.findByRole('menuitem', { name: 'Re-sign 45 passes' }));
    expect(body).toBeUndefined();
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Re-sign 45 passes?')).toBeVisible();
    await ui.click(within(dialog).getByRole('button', { name: 'Re-sign' }));
    await waitFor(() => expect(body).toEqual({ cause: 'resign', identityId: 'i1' }));
  });

  it.each([
    [{ health: 'healthy', status: 400, reason: 'BadDeviceToken' }, 'Healthy'],
    [
      { health: 'failing', status: 403, reason: 'BadCertificate' },
      'Apple rejected the push certificate. Upload a new one.',
    ],
  ])('checks APNs and shows the result inline', async (reply, line) => {
    let calls = 0;
    await renderApp('/admin/identities/i1', {
      session: 'admin',
      handlers: {
        '/api/v1/identities/i1/apns-check': () => {
          calls += 1;
          return json({ ...reply, checkedAt: 1_700_000_000_000 });
        },
        '/api/v1/identities/i1': () => json(identity({ apnsHealth: 'unknown' })),
      },
    });
    const ui = userEvent.setup();
    await ui.click(await screen.findByRole('button', { name: 'Check' }));
    expect(await screen.findByText(line)).toBeInTheDocument();
    expect(calls).toBe(1);
    if (reply.health === 'failing')
      expect(screen.getByText('BadCertificate')).toHaveClass('font-mono');
  });

  it('shows the error when the check fails', async () => {
    await renderApp('/admin/identities/i1', {
      session: 'admin',
      handlers: {
        '/api/v1/identities/i1/apns-check': () =>
          problem(429, 'RATE_LIMITED', 'Too many requests. Try again shortly.'),
        '/api/v1/identities/i1': () => json(identity()),
      },
    });
    const ui = userEvent.setup();
    await ui.click(await screen.findByRole('button', { name: 'Check' }));
    expect(await screen.findByText(/Too many requests/)).toBeInTheDocument();
  });

  it('rotates the certificate from PEM input', async () => {
    let body: unknown;
    await renderApp('/admin/identities/i1', {
      session: 'admin',
      handlers: {
        '/api/v1/identities/i1': () => json(identity()),
        '/api/v1/identities/i1/rotate': (_u, init) => {
          body = JSON.parse(String(init?.body));
          return json(identity());
        },
      },
    });
    const ui = userEvent.setup();
    await ui.click(await screen.findByRole('button', { name: 'More' }));
    await ui.click(await screen.findByRole('menuitem', { name: 'Rotate certificate' }));
    const dialog = await screen.findByRole('dialog');
    await ui.click(within(dialog).getByRole('button', { name: 'Replace certificate' }));
    expect(await within(dialog).findByText('Choose a .p12 file.')).toBeInTheDocument();
    await ui.click(within(dialog).getByRole('radio', { name: 'PEM certificate and key' }));
    await ui.type(
      within(dialog).getByLabelText('Certificate (PEM)'),
      '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----',
    );
    await ui.type(
      within(dialog).getByLabelText('Private key (PEM)'),
      '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
    );
    await ui.click(within(dialog).getByRole('button', { name: 'Replace certificate' }));
    await waitFor(() =>
      expect(body).toEqual({
        certificatePem: '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----',
        privateKeyPem: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
      }),
    );
  });

  it('shows not found with the way back to the list', async () => {
    await renderApp('/admin/identities/zzz', { session: 'admin' });
    expect(await screen.findByText('Apple identity not found')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Identity' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Apple identities' })).toHaveAttribute(
      'href',
      '/admin/identities',
    );
  });
});
