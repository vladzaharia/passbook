import { beforeAll, describe, expect, it } from 'vitest';
import { staffSessionFixture } from './staff-session-test-fixtures.ts';

const f = staffSessionFixture();
beforeAll(async () => {
  await f.setup();
});

const email = () => f.fake.session({ amr: 'magic_link', roles: ['user'] });

describe('an email session on the scanner routes', () => {
  it('is no session: an unpaired browser is asked to pair', async () => {
    const res = await f.call('GET', '/scan/session', email());
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'SCANNER_UNAUTHENTICATED' });
  });

  it('does not displace the paired device credential in the same browser', async () => {
    const scanner = await f.kit.scanner({ templateIds: [f.deskTemplate] });
    const mine = email();
    const res = await f.call('GET', '/scan/session', {
      ...scanner.headers,
      cookie: [scanner.headers.cookie, mine.cookie].filter(Boolean).join('; '),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ scanner: { id: scanner.id } });
  });

  it('is refused for Scan as Admin, with the sign-in code', async () => {
    const res = await f.call('GET', '/scan/session', {
      ...email(),
      'x-passbook-scan-admin': '1',
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'IDP_SIGN_IN_REQUIRED' });
  });
});
