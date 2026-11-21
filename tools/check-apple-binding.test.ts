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
