import { describe, expect, it } from 'vitest';
import { AppError } from '../../platform/errors.ts';
import { ascClient } from './asc-client.ts';

const failing = (message: string) => ({
  APPLE: {
    findPassType: () => Promise.reject(new Error(message)),
    calls: () => Promise.resolve([]),
  },
});

describe('ascClient', () => {
  it.each([
    ['ASC_REFUSED: Reserved handle.', 'ASC_REFUSED', 403],
    ['ASC_BUDGET: Call budget reached.', 'RATE_LIMITED', 429],
    ['ASC_NOT_FOUND: Apple answered 404.', 'ASC_NOT_FOUND', 404],
    ['ASC_CONFLICT: Apple answered 409.', 'ASC_CONFLICT', 409],
    ['ASC_AUTH: Apple answered 401.', 'ASC_AUTH', 503],
    ['ASC_UPSTREAM: Apple answered 500.', 'ASC_UPSTREAM', 502],
    ['socket closed', 'ASC_UPSTREAM', 502],
  ])('maps %s', async (message, code, status) => {
    const err = await ascClient(failing(message))
      .findPassType('x')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code, status });
  });

  it('passes results through and reports a missing binding', async () => {
    expect(await ascClient(failing('x')).calls(0)).toEqual([]);
    await expect(ascClient({}).calls(0)).rejects.toMatchObject({
      code: 'ASC_UNAVAILABLE',
      status: 503,
    });
  });
});
