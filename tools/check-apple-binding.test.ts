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

  it('allows the workflow and the client', () => {
    const text = 'env.APPLE.findPassType(x);';
    expect(findAppleBinding('src/worker/workflows/identity-provision.ts', text)).toEqual([]);
    expect(findAppleBinding('src/worker/modules/identities/asc-client.ts', text)).toEqual([]);
    expect(findAppleBinding('src/worker/modules/identities/asc-client.test.ts', text)).toEqual([]);
  });
});
