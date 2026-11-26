import { describe, expect, it } from 'vitest';
import { seedArgs } from './passbook-apple-connector-seed.ts';

describe('seedArgs', () => {
  it('targets the local D1 unless --remote is given', () => {
    expect(seedArgs(false, 1)).toContain('--local');
    expect(seedArgs(false, 1)).not.toContain('--remote');
    expect(seedArgs(true, 1)).toContain('--remote');
    expect(seedArgs(false, 1).at(-1)).toContain("'pass.im.plrs.wallet'");
  });
});
