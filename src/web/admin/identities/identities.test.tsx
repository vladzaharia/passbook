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
          }),
      },
    });
    expect(await screen.findByText('100 days left')).toBeInTheDocument();
    expect(screen.getByText('4 days left')).toBeInTheDocument();
    expect(screen.getByText('Expired 3 days ago')).toBeInTheDocument();
    expect(screen.getByText('Push unavailable')).toBeInTheDocument();
    expect(screen.getByText('Healthy')).toBeInTheDocument();
    expect(screen.getByText('Failing')).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('shows empty and error states', async () => {
    await renderApp('/admin/identities', {
      session: 'admin',
      handlers: { '/api/v1/identities': () => json({ items: [] }) },
    });
    expect(await screen.findByText('No identities')).toBeInTheDocument();
  });

  it('shows an error', async () => {
    await renderApp('/admin/identities', {
      session: 'admin',
      handlers: { '/api/v1/identities': () => problem(500, 'x', 'x') },
    });
    expect(await screen.findByText('Server error. Try again.')).toBeInTheDocument();
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
          return json({ items: [] });
        },
      },
    });
    const ui = userEvent.setup();
    await ui.click((await screen.findAllByRole('button', { name: 'Upload' }))[0]!);
    const dialog = await screen.findByRole('dialog');
    await ui.click(within(dialog).getByRole('button', { name: 'Upload' }));
    expect(await within(dialog).findByText('Choose a .p12 file.')).toBeInTheDocument();
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
              apnsBinding: null,
              apnsHealth: 'unknown',
              source: 'env',
            }),
          ),
      },
    });
    expect(await screen.findByText('APNs binding missing')).toBeInTheDocument();
    expect(screen.getByText(/mtls-certificate upload/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
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
    await ui.click(await screen.findByLabelText('NFC enabled'));
    await ui.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(body).toBeDefined());
    expect(body).toEqual({ label: 'Platform', nfcEnabled: true, isDefault: true });
  });

  it('deletes after confirmation', async () => {
    let deleted = false;
    await renderApp('/admin/identities/i1', {
      session: 'admin',
      handlers: {
        '/api/v1/identities': () => json({ items: [] }),
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
  });

  it('re-signs all passes of the identity after confirmation', async () => {
    let body: unknown;
    await renderApp('/admin/identities/i1', {
      session: 'admin',
      handlers: {
        '/api/v1/identities/i1': () => json(identity()),
        '/api/v1/passes/bulk-reissue': (_u, init) => {
          body = JSON.parse(String(init?.body));
          return json({ workflowInstanceId: 'bulk-1' });
        },
      },
    });
    const ui = userEvent.setup();
    await ui.click(await screen.findByRole('button', { name: 'Re-sign all passes' }));
    expect(body).toBeUndefined();
    await ui.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Re-sign' }),
    );
    await waitFor(() => expect(body).toEqual({ cause: 'resign', identityId: 'i1' }));
  });

  it.each([
    [
      { health: 'healthy', status: 400, reason: 'BadDeviceToken' },
      'APNs accepted the certificate.',
    ],
    [
      { health: 'failing', status: 403, reason: 'BadCertificate' },
      'APNs rejected the certificate: BadCertificate.',
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
        '/api/v1/identities/i1': () => json(identity()),
      },
    });
    const ui = userEvent.setup();
    await ui.click(await screen.findByRole('button', { name: 'Check APNs' }));
    expect(await screen.findByText(line)).toBeInTheDocument();
    expect(calls).toBe(1);
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
    await ui.click(await screen.findByRole('button', { name: 'Check APNs' }));
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

  it('shows not found', async () => {
    await renderApp('/admin/identities/zzz', { session: 'admin' });
    expect(await screen.findByText('Identity not found')).toBeInTheDocument();
  });
});
