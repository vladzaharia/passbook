import { describe, expect, it } from 'vitest';
import { EMAIL_LIMIT_COPY, ISSUANCE_OUTCOME_COPY } from '@/shared/copy/email.ts';
import { ApiError } from '../../lib/errors.ts';
import { classifyEmailError } from './email-outcome.ts';

const limited = (limit: string) =>
  new ApiError({ status: 429, code: 'EMAIL_RATE_LIMITED', fields: { limit } });

describe('email limit toasts', () => {
  it('names the daily limit', () => {
    expect(classifyEmailError(limited('org'))).toEqual({
      state: 'retrying',
      action: 'Daily email limit reached. The rest send tomorrow.',
    });
  });
  it('names the recipient limit', () => {
    expect(classifyEmailError(limited('recipient')).action).toBe(EMAIL_LIMIT_COPY.recipient);
  });
  it('keeps the busy wording for any other 429', () => {
    expect(classifyEmailError(new ApiError({ status: 429, code: 'RATE_LIMITED' })).action).toBe(
      'Wait a minute, then send again.',
    );
  });
});

describe('issuance outcome copy', () => {
  it.each(['queued', 'deferred', 'limited_org', 'limited_recipient', 'cancelled', 'none'] as const)(
    'has a plain sentence for %s',
    (outcome) => {
      const line = ISSUANCE_OUTCOME_COPY[outcome];
      expect(line).toMatch(/^[A-Z].*\.$/);
    },
  );
});
