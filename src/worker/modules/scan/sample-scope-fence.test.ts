import { describe, expect, it } from 'vitest';
import { type SampleScannerScope, sampleScannerScopeFence } from './sample-scope-fence.ts';

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

describe('sample scanner scope fence', () => {
  it('binds the entire scope once without interpolating captured values into SQL', () => {
    const fence = sampleScannerScopeFence(scope, 'org-1', 'test', 'template-1');
    expect(fence.sql.match(/\?/g)).toHaveLength(1);
    expect(fence.params).toHaveLength(1);
    expect(fence.sql).toContain('json_extract(sample_bind.values_json');
    expect(fence.sql).not.toContain(scope.scanner.settings);
    expect(JSON.parse(fence.params[0] as string)).toContain(scope.scanner.settings);
  });

  it('fails closed for a mismatched or malformed captured scope', () => {
    expect(sampleScannerScopeFence(scope, 'another-org', 'test', 'template-1').sql).toBe('0');
    expect(sampleScannerScopeFence(scope, 'org-1', 'live', 'template-1').sql).toBe('0');
    expect(
      sampleScannerScopeFence(
        {
          ...scope,
          scannerScope: { event: null, templateIds: ['template-1', 'template-1'] },
        },
        'org-1',
        'test',
        'template-1',
      ).sql,
    ).toBe('0');
  });
});
