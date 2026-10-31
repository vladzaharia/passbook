import { describe, expect, it } from 'vitest';
import { parseBookmark, predeployProblems } from './predeploy.ts';

const ready = {
  vars: { OIDC_CLIENT_ID: 'abc123', TURNSTILE_SITE_KEY: '0x4AAAAAAAxyz' },
  d1_databases: [{ binding: 'DB', database_id: '6c0d3b34-8b53-4f3b-a2f6-9d6a1b0c7e11' }],
  mtls_certificates: [{ binding: 'APNS', certificate_id: '9d7b9372-b262-42c3-82db-e90c4c588e90' }],
};

describe('predeployProblems', () => {
  it('passes a finished config', () => {
    expect(predeployProblems(ready)).toEqual([]);
  });

  it('flags the zero D1 id, placeholder vars, Turnstile test keys and a missing APNS binding', () => {
    const problems = predeployProblems({
      vars: {
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
    expect(
      predeployProblems({
        ...ready,
        mtls_certificates: [{ binding: 'APNS', certificate_id: '<id>' }],
      }),
    ).toHaveLength(1);
  });
});

describe('parseBookmark', () => {
  it('finds a D1 bookmark in wrangler output', () => {
    const b = '00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683';
    expect(parseBookmark(`The current bookmark is '${b}'`)).toBe(b);
    expect(parseBookmark('nothing')).toBeNull();
  });
});
