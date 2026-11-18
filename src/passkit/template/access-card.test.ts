import { describe, expect, it } from 'vitest';
import type { PassJson } from '../types.ts';
import { accessIssues } from './access/index.ts';
import { loadBaked } from './baked-fixtures.ts';
import { ScanDisplayDocSchema } from './scan-display/schema.ts';
import { scanDisplayIssues } from './scan-display/validate.ts';

describe('starter-access-card', () => {
  it('passes accessIssues with no errors or warnings', async () => {
    const { template } = await loadBaked('starter-access-card', { strips: false });
    expect(accessIssues(template.manifest)).toEqual([]);
    expect(accessIssues(template.manifest, { zones: ['main', 'pool'] }).map((i) => i.code)).toEqual(
      [],
    );
  });

  it('ships the three plans', async () => {
    const { template } = await loadBaked('starter-access-card', { strips: false });
    const plans = template.manifest.scan?.access?.plans ?? [];
    expect(plans.map((p) => [p.id, p.kind, p.label])).toEqual([
      ['member', 'always', '24/7 Member'],
      ['off_peak', 'timed', 'Off-peak'],
      ['guest', 'guest', 'Guest'],
    ]);
  });

  it('carries a valid scan.display with a customer block', async () => {
    const { template } = await loadBaked('starter-access-card', { strips: false });
    const display = template.manifest.scan?.display;
    expect(() => ScanDisplayDocSchema.parse(display)).not.toThrow();
    expect(display?.customer?.chips).toEqual(['c_plan', 'c_timed', 'c_guest']);
    const issues = scanDisplayIssues(template.manifest, {
      passJson: template.passJson as PassJson,
    });
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
  });
});
