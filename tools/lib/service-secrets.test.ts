import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { requireServiceSecrets, serviceSecretChecks } from './service-secrets.ts';

describe('serviceSecretChecks', () => {
  it('maps bound services to the required secrets of their wrangler config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'workers-'));
    mkdirSync(join(dir, 'a'));
    writeFileSync(
      join(dir, 'a', 'wrangler.jsonc'),
      '{ "name": "passbook-apple-connector", // c\n "secrets": { "required": ["ASC_KEY_P8"] } }',
    );
    const services = [{ service: 'passbook-apple-connector' }, { service: 'elsewhere' }];
    expect(serviceSecretChecks(services, dir)).toEqual([
      { service: 'passbook-apple-connector', required: ['ASC_KEY_P8'] },
    ]);
    expect(serviceSecretChecks(undefined, join(dir, 'none'))).toEqual([]);
    expect(() =>
      requireServiceSecrets(services, dir, () => '[{"name":"ASC_KEY_P8"}]'),
    ).not.toThrow();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    requireServiceSecrets(services, dir, () => '[]');
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(err.mock.calls[0]?.[0])).toContain('passbook-apple-connector lacks secrets');
    exit.mockRestore();
    err.mockRestore();
  });
});
