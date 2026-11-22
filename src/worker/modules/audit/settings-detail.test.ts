import { describe, expect, it } from 'vitest';
import { redactForRead } from './redact.ts';
import { tenantSettingsDetail } from './settings-detail.ts';

const read = (detail: unknown) => redactForRead(tenantSettingsDetail(detail), true);

describe('settings audit detail for a tenant', () => {
  it('shows old and new numbers and booleans with the setting key', () => {
    expect(
      read({
        changes: {
          'retention.scansDays': { from: 396, to: 200 },
          'email.buddy': { from: null, to: true },
        },
      }),
    ).toEqual({
      changes: [
        { label: 'retention.scansDays', from: 396, to: 200 },
        { label: 'email.buddy', from: null, to: true },
      ],
    });
  });

  it('drops text settings, so an address or name never reaches a reader', () => {
    expect(
      read({
        changes: {
          'support.email': { from: 'a@b.example', to: 'c@d.example' },
          'privacy.legalName': { from: 'Old Co', to: 'New Co' },
          'retention.eventsDays': { from: 90, to: 60 },
        },
      }),
    ).toEqual({ changes: [{ label: 'retention.eventsDays', from: 90, to: 60 }] });
  });

  it('leaves other details to the generic redaction', () => {
    expect(read({ detail: 'org' })).toEqual({ '[redacted]': '[redacted]' });
    expect(read({ scope: 'org' })).toEqual({ scope: 'org' });
  });
});
