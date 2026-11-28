import { describe, expect, it } from 'vitest';
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

  it("reads the organization's list shape", () => {
    expect(
      settingChanges({ changes: [{ label: 'retention.scansDays', from: 396, to: 200 }] }),
    ).toEqual([{ key: 'retention.scansDays', label: 'Scans', from: '396', to: '200' }]);
  });

  it('never shows a secret-looking setting value', () => {
    const [change] = settingChanges({ changes: { 'smtp.password': { from: 'a', to: 'b' } } }) ?? [];
    expect(change?.from).toBe('[redacted]');
    expect(change?.to).toBe('[redacted]');
  });

  it('reads a features change in the feature names and values', () => {
    expect(
      settingChanges({
        changes: {
          print: { from: 1, to: 0 },
          'passes.live': { from: null, to: 100 },
          nfc: { from: 'secure', to: 'basic' },
        },
      }),
    ).toEqual([
      { key: 'print', label: 'Print at home', from: 'On', to: 'Off' },
      { key: 'passes.live', label: 'Live passes', from: 'No limit', to: '100' },
      { key: 'nfc', label: 'NFC tags', from: 'Basic and Secure tags', to: 'Basic tags' },
    ]);
  });

  it('is undefined for details without changes', () => {
    expect(settingChanges({ scope: 'org' })).toBeUndefined();
    expect(settingChanges(null)).toBeUndefined();
  });
});
