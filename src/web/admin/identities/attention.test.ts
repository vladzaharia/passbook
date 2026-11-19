import { describe, expect, it } from 'vitest';
import { attentionTone, expiryPhrase, identityAttention } from './attention.ts';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const cert = (days: number, over: Record<string, unknown> = {}) =>
  ({
    id: `i${days}`,
    label: `Cert ${days}`,
    notBefore: NOW - 100 * DAY,
    notAfter: NOW + days * DAY + DAY / 2,
    daysRemaining: days,
    ...over,
  }) as never;

describe('attention severity', () => {
  it('is red at seven days or fewer, amber up to thirty', () => {
    expect(attentionTone(1, false)).toBe('danger');
    expect(attentionTone(7, false)).toBe('danger');
    expect(attentionTone(8, false)).toBe('warning');
    expect(attentionTone(-2, false)).toBe('danger');
    expect(attentionTone(null, true)).toBe('danger');
  });

  it('names the identity and its days left', () => {
    const top = identityAttention([cert(20), cert(1)], NOW);
    expect(top?.identity.label).toBe('Cert 1');
    expect(top?.tone).toBe('danger');
    expect(top?.count).toBe(2);
    expect(identityAttention([cert(20)], NOW)?.tone).toBe('warning');
    expect(identityAttention([cert(90)], NOW)).toBeUndefined();
  });

  it('phrases the time left', () => {
    expect(expiryPhrase(1)).toBe('expires in 1 day');
    expect(expiryPhrase(0)).toBe('expires today');
    expect(expiryPhrase(-3)).toBe('expired 3 days ago');
  });
});
