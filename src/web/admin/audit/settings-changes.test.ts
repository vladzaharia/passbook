import { describe, expect, it } from 'vitest';
import { auditCsv } from './export.ts';
import { settingChanges } from './settings-changes.tsx';

describe('settingChanges', () => {
  it('reads old and new values with the setting names', () => {
    expect(
      settingChanges({
        changes: {
          'retention.scansDays': { from: 396, to: 200 },
          'email.buddy': { from: null, to: true },
        },
      }),
    ).toEqual([
      { key: 'retention.scansDays', label: 'Scans', from: '396', to: '200' },
      { key: 'email.buddy', label: expect.any(String), from: 'Default', to: 'On' },
    ]);
  });

  it('never shows a secret-looking setting value', () => {
    const [change] = settingChanges({ changes: { 'smtp.password': { from: 'a', to: 'b' } } }) ?? [];
    expect(change?.from).toBe('[redacted]');
    expect(change?.to).toBe('[redacted]');
  });

  it('is undefined for details without changes', () => {
    expect(settingChanges({ scope: 'org' })).toBeUndefined();
    expect(settingChanges(null)).toBeUndefined();
  });
});

describe('auditCsv', () => {
  it('quotes cells and defuses formulas; leaves detail out', () => {
    const csv = auditCsv(
      [
        {
          id: 1,
          at: 0,
          orgId: 'o1',
          actorType: 'user',
          actorId: 'u1',
          actorLabel: '=HYPERLINK("x")',
          action: 'retention.hold.place',
          targetType: 'retention_hold',
          targetId: 'h1',
          targetLabel: null,
          requestId: null,
          detail: { reason: 'secret reason' },
        },
      ],
      () => 'Acme, Inc',
    );
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain('"Acme, Inc"');
    expect(csv).toContain('Legal hold placed');
    expect(csv).not.toContain('secret reason');
  });
});
