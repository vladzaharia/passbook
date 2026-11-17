import { describe, expect, it } from 'vitest';
import { Binds } from '../../platform/authority-principal.ts';
import { type SampleScannerScope, sampleScannerScopeCheck } from './sample-scope-fence.ts';

const scope: SampleScannerScope = {
  scanner: {
    id: 'scanner-1',
    orgId: 'org-1',
    mode: 'test',
    kind: 'device',
    deviceRole: 'scan',
    eventId: null,
    settings: '{"label":"?"}',
    timeZone: 'UTC',
    updatedAt: 1,
    revokedAt: null,
  },
  scannerScope: { event: null, templateIds: ['template-1'] },
  session: null,
};

/** The check as the grant insert renders it over the actor row `a`. */
const render = (check: ReturnType<typeof sampleScannerScopeCheck>) => {
  const b = new Binds();
  return { sql: check.ok(b, 'org_mode'), params: b.params };
};

describe('sample scanner scope check', () => {
  it('binds the scope once, takes the tenant from the grant and interpolates no captured value', () => {
    const check = sampleScannerScopeCheck(scope, 'org-1', 'test', 'template-1');
    expect(check.reason).toBe('config');
    const { sql, params } = render(check);
    expect(sql.match(/\?/g)).toHaveLength(1);
    expect(params).toHaveLength(1);
    expect(sql).toContain('json_extract(sample_bind.values_json');
    expect(sql).toContain('s.org_id=a.org_id AND s.mode=a.mode');
    expect(sql).not.toContain(scope.scanner.settings);
    const values = JSON.parse(params[0] as string) as unknown[];
    expect(values).toContain(scope.scanner.settings);
    expect(values).not.toContain('org-1');
  });

  it('refuses a mismatched or malformed captured scope', () => {
    const refused = (check: ReturnType<typeof sampleScannerScopeCheck>) =>
      expect(render(check).sql).toBe('0 = 1');
    refused(sampleScannerScopeCheck(scope, 'another-org', 'test', 'template-1'));
    refused(sampleScannerScopeCheck(scope, 'org-1', 'live', 'template-1'));
    refused(sampleScannerScopeCheck(scope, 'org-1', 'test', 'template-2'));
    refused(
      sampleScannerScopeCheck(
        { ...scope, scannerScope: { event: null, templateIds: ['template-1', 'template-1'] } },
        'org-1',
        'test',
        'template-1',
      ),
    );
  });
});
