import { describe, expect, it } from 'vitest';
import { findAppleBinding } from './check-apple-binding.ts';

describe('findAppleBinding', () => {
  it('catches a stray env.APPLE, however it is spelled', () => {
    const text = [
      'const a = env.APPLE;',
      "const b = c.env['APPLE'];",
      'const { APPLE } = env;',
      'const { APPLE: svc } = env;',
      'const ok = env.DB;',
    ].join('\n');
    expect(findAppleBinding('src/worker/modules/passes/service.ts', text)).toEqual([
      'src/worker/modules/passes/service.ts:1',
      'src/worker/modules/passes/service.ts:2',
      'src/worker/modules/passes/service.ts:3',
      'src/worker/modules/passes/service.ts:4',
    ]);
  });

  it('catches dynamic access and whole-env reads', () => {
    const f = 'src/worker/modules/passes/service.ts';
    const bad = [
      "const a = env['AP' + 'PLE'];",
      "const k = 'AP' + 'PLE'; const a = env[k];",
      'const a = env[name];',
      'const a = c.env[name];',
      'const a = env[`APPLE`];',
      'const v = Object.values(env);',
      'const v = Object.entries(c.env);',
      'const v = Reflect.get(env, key);',
      'const { DB, ...rest } = env; rest.APPLE;',
      "const { DB, ...rest } = c.env; rest['APPLE'];",
      'const { DB, ...rest } = c.env; rest[key];',
      'const copy = { ...env, DB: x }; copy.APPLE;',
      'const copy = { ...env } as Env; Object.values(copy);',
      'function f({ DB, ...rest }: Env) { return rest[k]; }',
    ];
    for (const line of bad) expect(findAppleBinding(f, line), line).toHaveLength(1);
    const ok = [
      'const a = env.DB;',
      'const { DB, ...rest } = other;',
      'const m = { ...opts };',
      'const a = table[name];',
      'const v = Object.values(map);',
      'function f({ a, ...rest }: Props) { return rest[k]; }',
      'const copy = { ...env, DB: x }; copy.DB;',
      'const { DB, ...rest } = env; rest.TURNSTILE;',
    ];
    for (const line of ok) expect(findAppleBinding(f, line), line).toEqual([]);
    expect(findAppleBinding('src/worker/workflows/identity-provision.ts', bad.join('\n'))).toEqual(
      [],
    );
  });

  it('lets reviewed files read the env by key, but never name APPLE', () => {
    const f = 'src/worker/platform/crypto.ts';
    expect(findAppleBinding(f, 'const a = env[name]; Object.keys(env);')).toEqual([]);
    expect(findAppleBinding(f, "const a = env['AP' + 'PLE'];")).toEqual([`${f}:1`]);
    expect(findAppleBinding('src/worker/x/some.test.ts', 'Object.values(env);')).toEqual([]);
    expect(
      findAppleBinding('src/worker/x/some.test.ts', 'Object.assign(env, { DB: db });'),
    ).toEqual([]);
  });

  it('catches imports of the client outside the workflow', () => {
    const text = [
      "import { ascClient } from '../identities/asc-client.ts';",
      "const m = await import('./asc-client');",
      "export * from './asc-client.ts';",
      "import { x } from './other.ts';",
    ].join('\n');
    expect(findAppleBinding('src/worker/modules/passes/service.ts', text)).toHaveLength(3);
    expect(findAppleBinding('src/worker/workflows/identity-provision.ts', text)).toEqual([]);
  });

  it('allows the workflow and the client', () => {
    const text = 'env.APPLE.findPassType(x);';
    expect(findAppleBinding('src/worker/workflows/identity-provision.ts', text)).toEqual([]);
    expect(findAppleBinding('src/worker/modules/identities/asc-client.ts', text)).toEqual([]);
    expect(findAppleBinding('src/worker/modules/identities/asc-client.test.ts', text)).toEqual([]);
  });

  it('lets the ledger reader name the binding, but only to read `calls`', () => {
    const ledger = 'src/worker/modules/identities/asc-ledger.ts';
    expect(findAppleBinding(ledger, 'const rpc = env.APPLE; await rpc.calls(0);')).toEqual([]);
    expect(findAppleBinding(ledger, 'await env.APPLE.revokeCertificate(a, b);')).toEqual([
      `${ledger}:1`,
    ]);
    expect(findAppleBinding(ledger, 'await rpc.createCertificate(a);')).toEqual([`${ledger}:1`]);
    expect(findAppleBinding(ledger, "import { ascClient } from './asc-client.ts';")).toEqual([
      `${ledger}:1`,
    ]);
  });
});
