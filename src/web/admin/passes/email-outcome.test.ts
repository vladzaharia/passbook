import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/errors.ts';
import { classifyEmailError } from './email-outcome.ts';

const err = (status: number) => new ApiError({ status, code: 'X' });

describe('classifyEmailError', () => {
  it('names the hourly and daily caps on 429', () => {
    const { state, action } = classifyEmailError(err(429));
    expect(state).toBe('retrying');
    expect(action).toContain('an hour');
    expect(action).toContain('a day');
  });

  it('keeps the short wait for 503', () => {
    expect(classifyEmailError(err(503)).action).toBe('Wait a minute, then send again.');
  });
});
