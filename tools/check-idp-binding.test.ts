import { describe, expect, it } from 'vitest';
import { findIdpBinding } from './check-idp-binding.ts';

const f = 'src/worker/modules/dev-access/service-invite.ts';

describe('findIdpBinding', () => {
  it('catches a stray env.IDP, however it is spelled', () => {
    const text = [
      'const a = env.IDP;',
      "const b = c.env['IDP'];",
      'const { IDP } = env;',
      'const { IDP: svc } = env;',
      'const ok = env.DB;',
      'const apple = env.APPLE;',
    ].join('\n');
    expect(findIdpBinding(f, text)).toEqual([`${f}:1`, `${f}:2`, `${f}:3`, `${f}:4`]);
  });

  it('catches dynamic access and whole-env reads', () => {
    const bad = [
      "const a = env['I' + 'DP'];",
      "const k = 'I' + 'DP'; const a = env[k];",
      'const a = c.env[name];',
      'const v = Object.values(env);',
      'const { DB, ...rest } = env; rest.IDP;',
      'const copy = { ...env, DB: x }; copy.IDP;',
    ];
    for (const line of bad) expect(findIdpBinding(f, line), line).toHaveLength(1);
    expect(findIdpBinding(f, 'const a = env.DB; const v = Object.values(map);')).toEqual([]);
  });

  it('lets only the client name it, in any file of the tree', () => {
    const text = 'const rpc = env.IDP;';
    expect(findIdpBinding('src/worker/modules/idp/client.ts', text)).toEqual([]);
    expect(findIdpBinding('src/worker/modules/idp/client.test.ts', text)).toEqual([]);
    expect(findIdpBinding('src/worker/modules/dev-access/repo.ts', text)).toHaveLength(1);
    expect(findIdpBinding('src/worker/modules/dev-access/idp-client.ts', text)).toHaveLength(1);
    expect(findIdpBinding('src/worker/modules/idp/errors.ts', text)).toHaveLength(1);
    expect(findIdpBinding('src/worker/modules/idp/client-extra.ts', text)).toHaveLength(1);
    expect(findIdpBinding('src/worker/modules/identities/idp-client.ts', text)).toHaveLength(1);
    expect(findIdpBinding('src/worker/app.ts', text)).toHaveLength(1);
  });
});
