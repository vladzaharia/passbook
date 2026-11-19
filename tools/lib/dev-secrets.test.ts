import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEV_ONLY_SECRETS, LOCAL_SECRETS, localSecrets } from './dev-secrets.ts';
import { parseJsonc } from './jsonc.ts';

const config = parseJsonc(readFileSync('wrangler.jsonc', 'utf8')) as {
  secrets?: { required?: string[] };
};

describe('local secrets', () => {
  it('names KEK_V1 for vite dev and the e2e build, which production does not require', () => {
    expect(localSecrets(true).secrets.required).toEqual([...LOCAL_SECRETS]);
    expect(LOCAL_SECRETS).toContain('KEK_V1');
    // The deployed config must keep it optional, or V1 could never be retired.
    expect(config.secrets?.required).not.toContain('KEK_V1');
  });

  it('lets vite dev see the fixture WWDR that dev:vars writes, but not the e2e build', () => {
    expect(localSecrets().secrets.required).toEqual([...LOCAL_SECRETS, ...DEV_ONLY_SECRETS]);
    expect(localSecrets().secrets.required).toContain('SIGNER_PLATFORM_INTERMEDIATE');
    expect(localSecrets(true).secrets.required).toEqual([...LOCAL_SECRETS]);
    expect(config.secrets?.required).not.toContain('SIGNER_PLATFORM_INTERMEDIATE');
  });

  it('is applied only to local runs in vite.config.ts', () => {
    const vite = readFileSync('vite.config.ts', 'utf8');
    expect(vite).toContain("command === 'serve' || e2e ? localSecrets(e2e) : {}");
  });
});
