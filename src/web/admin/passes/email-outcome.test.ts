import { describe, expect, it, vi } from 'vitest';
import { EMAIL_LIMIT_COPY, ISSUANCE_OUTCOME_COPY } from '@/shared/copy/email.ts';
import { ApiError } from '../../lib/errors.ts';
import { toast } from '../../ui/index.ts';
import { classifyEmailError, reportIssuanceOutcome } from './email-outcome.ts';

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

const kit = vi.hoisted(() => ({ calls: [] as string[] }));

describe('issuance toast per outcome', () => {
  it.each([
    ['queued', 'success'],
    ['deferred', 'info'],
    ['none', 'info'],
    ['cancelled', 'info'],
    ['limited_org', 'warning'],
    ['limited_recipient', 'warning'],
  ] as const)('%s uses toast.%s with its sentence', (outcome, kind) => {
    kit.calls.length = 0;
    for (const k of ['success', 'info', 'warning'] as const)
      vi.spyOn(toast, k).mockImplementation(((m: string) => kit.calls.push(`${k}:${m}`)) as never);
    reportIssuanceOutcome(outcome);
    expect(kit.calls).toEqual([`${kind}:${ISSUANCE_OUTCOME_COPY[outcome]}`]);
    vi.restoreAllMocks();
  });
});
