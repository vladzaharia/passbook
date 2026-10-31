import { describe, expect, it } from 'vitest';
import {
  addMtlsBinding,
  parseCertificateId,
  parseIdentityAddArgs,
  uploadArgs,
} from './identity-add.ts';
import { parseJsonc } from './jsonc.ts';

const ID = '9d7b9372-b262-42c3-82db-e90c4c588e90';

describe('identity-add', () => {
  it('defaults to a dry run on the platform identity', () => {
    const o = parseIdentityAddArgs([]);
    expect(o).toMatchObject({
      name: 'platform',
      binding: 'APNS',
      cert: '.secrets/platform-certificate.pem',
      apply: false,
    });
    expect(uploadArgs(o)).toContain('wallet-platform');
  });

  it('derives APNS_<NAME> for other identities and validates input', () => {
    expect(parseIdentityAddArgs(['--name', 'acme-gym', '--apply'])).toMatchObject({
      binding: 'APNS_ACME_GYM',
      apply: true,
    });
    expect(() => parseIdentityAddArgs(['--name', 'Bad Name'])).toThrow();
    expect(() => parseIdentityAddArgs(['--binding', 'apns'])).toThrow();
    expect(() => parseIdentityAddArgs(['stray'])).toThrow();
  });

  it('reads the certificate id from wrangler output', () => {
    expect(
      parseCertificateId(`Success! Uploaded mTLS Certificate wallet-platform\nID: ${ID}`),
    ).toBe(ID);
    expect(() => parseCertificateId('nope')).toThrow();
  });

  it('adds a binding and repoints an existing one, keeping comments', () => {
    const text = '{\n  // keep\n  "name": "x",\n}\n';
    const added = addMtlsBinding(text, 'APNS', ID);
    expect(added).toContain('// keep');
    expect(parseJsonc(added)).toMatchObject({ mtls_certificates: [{ binding: 'APNS' }] });
    const other = '11111111-1111-1111-1111-111111111111';
    const repointed = addMtlsBinding(addMtlsBinding(added, 'APNS_B', ID), 'APNS', other);
    expect(parseJsonc(repointed)).toMatchObject({
      mtls_certificates: [
        { binding: 'APNS', certificate_id: other },
        { binding: 'APNS_B', certificate_id: ID },
      ],
    });
  });
});
