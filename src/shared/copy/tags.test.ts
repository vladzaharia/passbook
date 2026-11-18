import { describe, expect, it } from 'vitest';
import { TAG_ERROR_CODES } from '../contracts/nfc-tags.ts';
import { SCAN_COPY, SCAN_REASON_COPY } from './scan.ts';
import { CUSTOMER_COPY, CUSTOMER_REASON_SUB } from './scan-customer.ts';
import { TAG_COPY, TAG_ERROR_COPY } from './tags.ts';

const TAG_REASONS = ['tag_lost', 'tag_not_allowed', 'tag_invalid'] as const;

describe('tag copy', () => {
  it.each(TAG_REASONS)(
    '%s has scanner copy and a customer line that says nothing more',
    (reason) => {
      expect(SCAN_REASON_COPY[reason].headline.length).toBeGreaterThan(0);
      expect(SCAN_REASON_COPY[reason].sub.length).toBeGreaterThan(0);
      expect(CUSTOMER_REASON_SUB[reason]).toBeNull();
      expect(CUSTOMER_COPY.refusedLine).toBe('Please see the desk');
    },
  );

  it('uses the deck words for the scanner', () => {
    expect(SCAN_REASON_COPY.tag_lost.sub).toBe('Keep it and call security.');
    expect(SCAN_REASON_COPY.tag_not_allowed.sub).toBe("This tag isn't accepted here.");
    expect(SCAN_REASON_COPY.tag_invalid.sub).toBe('Try again or use the card.');
    expect(SCAN_COPY.tags.menu.assign).toBe('Assign tag');
    expect(SCAN_COPY.tags.needsConnection).toBe('Tag needs a connection');
  });

  it.each(TAG_ERROR_CODES)('%s has one sentence', (code) => {
    expect(TAG_ERROR_COPY[code]).toMatch(/^[A-Z].*\.$/);
    expect(TAG_ERROR_COPY[code].split('. ').length).toBeLessThanOrEqual(2);
  });

  it('has no error text for an unknown code', () => {
    expect(Object.keys(TAG_ERROR_COPY).sort()).toEqual([...TAG_ERROR_CODES].sort());
  });

  it('names tags the way the deck does', () => {
    expect(TAG_COPY.kind).toEqual({
      secure: 'Secure',
      basic: 'Basic',
      lost: 'Lost',
      lent: 'Lent',
      spare: 'Spare',
    });
    expect(TAG_COPY.portal.reportLost).toBe('Report lost');
  });
});
