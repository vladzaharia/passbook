import { describe, expect, it } from 'vitest';
import {
  CreateDataRequestSchema,
  DATA_REQUEST_DUE_DAYS,
  DeclineDataRequestSchema,
  ExtendDataRequestSchema,
} from './data-requests.ts';

describe('data request contracts', () => {
  it('a request names an org and a kind; the note is optional and bounded', () => {
    expect(CreateDataRequestSchema.safeParse({ orgId: 'o', kind: 'erasure' }).success).toBe(true);
    expect(
      CreateDataRequestSchema.safeParse({ orgId: 'o', kind: 'export', note: 'x'.repeat(1000) })
        .success,
    ).toBe(true);
    expect(
      CreateDataRequestSchema.safeParse({ orgId: 'o', kind: 'export', note: 'x'.repeat(1001) })
        .success,
    ).toBe(false);
    expect(CreateDataRequestSchema.safeParse({ orgId: 'o', kind: 'delete' }).success).toBe(false);
    expect(CreateDataRequestSchema.safeParse({ kind: 'export' }).success).toBe(false);
  });

  it('a decline needs a known reason and a message up to 500 characters', () => {
    expect(
      DeclineDataRequestSchema.safeParse({ reason: 'contract', message: 'We keep invoices.' })
        .success,
    ).toBe(true);
    expect(DeclineDataRequestSchema.safeParse({ reason: 'other', message: '' }).success).toBe(
      false,
    );
    expect(DeclineDataRequestSchema.safeParse({ reason: 'because', message: 'x' }).success).toBe(
      false,
    );
    expect(
      DeclineDataRequestSchema.safeParse({ reason: 'other', message: 'x'.repeat(501) }).success,
    ).toBe(false);
  });

  it('an extension adds up to 60 days and defaults to 60', () => {
    expect(ExtendDataRequestSchema.parse({ message: 'Complex.' }).days).toBe(60);
    expect(ExtendDataRequestSchema.safeParse({ message: 'x', days: 61 }).success).toBe(false);
    expect(DATA_REQUEST_DUE_DAYS).toBe(30);
  });
});
