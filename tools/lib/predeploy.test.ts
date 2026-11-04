import { describe, expect, it } from 'vitest';
import { parseBookmark, predeployProblems } from './predeploy.ts';

const ready = {
  vars: {
    PUBLIC_BASE_URL: 'https://passbook.example',
    REDIRECT_HOSTS: 'old.example',
    EMAIL_FROM: 'delivery@passbook.example',
    OIDC_CLIENT_ID: 'abc123',
    TURNSTILE_SITE_KEY: '0x4AAAAAAAxyz',
  },
  routes: [
    { pattern: 'passbook.example', custom_domain: true },
    { pattern: 'old.example', custom_domain: true },
  ],
  send_email: [{ name: 'EMAIL', allowed_sender_addresses: ['delivery@passbook.example'] }],
  d1_databases: [{ binding: 'DB', database_id: '6c0d3b34-8b53-4f3b-a2f6-9d6a1b0c7e11' }],
  mtls_certificates: [{ binding: 'APNS', certificate_id: '9d7b9372-b262-42c3-82db-e90c4c588e90' }],
};

describe('predeployProblems', () => {
  it('passes a finished config', () => {
    expect(predeployProblems(ready)).toEqual([]);
  });

  it('flags the zero D1 id, placeholder vars, Turnstile test keys and a missing APNS binding', () => {
    const problems = predeployProblems({
      ...ready,
      mtls_certificates: [],
      vars: {
        ...ready.vars,
        OIDC_CLIENT_ID: 'wallet-placeholder-client-id',
        TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
      },
      d1_databases: [{ binding: 'DB', database_id: '00000000-0000-0000-0000-000000000000' }],
    });
    expect(problems).toHaveLength(4);
    expect(problems.join('\n')).toMatch(/database_id.*placeholder/);
    expect(problems.join('\n')).toMatch(/OIDC_CLIENT_ID/);
    expect(problems.join('\n')).toMatch(/TURNSTILE_SITE_KEY/);
    expect(problems.join('\n')).toMatch(/APNS/);
  });

  it('allows no push only when asked and rejects a bad certificate id', () => {
    const { mtls_certificates: _m, ...noPush } = ready;
    expect(predeployProblems(noPush)).toHaveLength(1);
    expect(predeployProblems(noPush, { allowNoPush: true })).toEqual([]);
  });

  it('allows a placeholder OIDC client id only with allowNoOidc', () => {
    const config = {
      ...ready,
      mtls_certificates: [],
      vars: { ...ready.vars, OIDC_CLIENT_ID: 'wallet-placeholder-client-id' },
    };
    expect(predeployProblems(config, { allowNoPush: true })).toHaveLength(1);
    expect(predeployProblems(config, { allowNoPush: true, allowNoOidc: true })).toEqual([]);
    expect(
      predeployProblems({
        ...ready,
        mtls_certificates: [{ binding: 'APNS', certificate_id: '<id>' }],
      }),
    ).toHaveLength(1);
  });
});

describe('predeployProblems with a client metadata document', () => {
  const vars = { ...ready.vars, PUBLIC_BASE_URL: 'https://passbook.example/' };

  it('accepts the metadata URL under PUBLIC_BASE_URL as the client id', () => {
    const config = {
      ...ready,
      vars: { ...vars, OIDC_CLIENT_ID: 'https://passbook.example/auth/oidc/client-metadata.json' },
    };
    expect(predeployProblems(config)).toEqual([]);
  });

  it('rejects a URL client id this Worker does not serve, such as the old host', () => {
    const config = {
      ...ready,
      vars: { ...vars, OIDC_CLIENT_ID: 'https://old.example/auth/oidc/client-metadata.json' },
    };
    expect(predeployProblems(config).join('\n')).toMatch(/OIDC_CLIENT_ID must be/);
  });
});

describe('predeployProblems for domains', () => {
  const problems = (patch: Partial<Parameters<typeof predeployProblems>[0]>) =>
    predeployProblems({ ...ready, ...patch }).join('\n');

  it('needs a custom domain for PUBLIC_BASE_URL', () => {
    expect(problems({ routes: [{ pattern: 'old.example', custom_domain: true }] })).toMatch(
      /no custom domain for passbook.example/,
    );
  });

  it('refuses a route that is neither canonical nor redirected, and a redirect host without one', () => {
    const extra = problems({
      routes: [...ready.routes, { pattern: 'stray.example', custom_domain: true }],
    });
    expect(extra).toMatch(/stray.example is not PUBLIC_BASE_URL/);
    const missing = problems({
      vars: { ...ready.vars, REDIRECT_HOSTS: 'old.example,gone.example' },
    });
    expect(missing).toMatch(/gone.example has no route/);
  });

  it('wants https, custom domains and an allowed sender', () => {
    expect(
      problems({ vars: { ...ready.vars, PUBLIC_BASE_URL: 'http://passbook.example' } }),
    ).toMatch(/must be https/);
    expect(problems({ routes: [{ pattern: 'passbook.example/*' }] })).toMatch(
      /only custom domains/,
    );
    expect(problems({ vars: { ...ready.vars, EMAIL_FROM: 'passes@other.example' } })).toMatch(
      /EMAIL_FROM passes@other.example is not in send_email/,
    );
  });
});

describe('parseBookmark', () => {
  it('finds a D1 bookmark in wrangler output', () => {
    const b = '00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683';
    expect(parseBookmark(`The current bookmark is '${b}'`)).toBe(b);
    expect(parseBookmark('nothing')).toBeNull();
  });
});
