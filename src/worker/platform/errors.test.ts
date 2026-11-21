import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ConflictError,
  FeatureLimitError,
  NotFoundError,
  problemResponse,
  RateLimitedError,
  toProblem,
} from './errors.ts';

describe('problem mapping', () => {
  it('maps AppError subclasses to stable codes', async () => {
    const res = problemResponse(new NotFoundError('No pass.', 'PASS_NOT_FOUND'), 'req-1');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(await res.json()).toMatchObject({
      code: 'PASS_NOT_FOUND',
      detail: 'No pass.',
      requestId: 'req-1',
      status: 404,
    });
  });

  it('says which limit a create reached, its cap and the count, in one sentence', async () => {
    const res = problemResponse(new FeatureLimitError({ key: 'api.keys', limit: 10, used: 10 }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      code: 'FEATURE_LIMIT_REACHED',
      feature: 'api.keys',
      limit: 10,
      used: 10,
      detail: 'API keys limit reached (10 of 10), ask PassBook for more.',
    });
  });

  it('adds retry-after for rate limits', () => {
    expect(problemResponse(new RateLimitedError(30)).headers.get('retry-after')).toBe('30');
  });

  it('turns zod errors into 422 with field issues', () => {
    const result = z.object({ a: z.string() }).safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const problem = toProblem(result.error);
      expect(problem.status).toBe(422);
      expect(problem.issues?.[0]?.path).toBe('a');
    }
  });

  it('never leaks the message of unexpected errors', () => {
    const problem = toProblem(new Error('SELECT * FROM secrets'));
    expect(problem).toMatchObject({ status: 500, code: 'INTERNAL' });
    expect(problem.detail).not.toContain('SELECT');
  });

  it('answers INTERNAL with the request id for an internal code', () => {
    for (const code of ['GRANT_NO_EDGE', 'WALLET_OP_STALE', 'STALE_CONTEXT', 'SQL_SIZE_BUDGET']) {
      const problem = toProblem(new ConflictError('internal detail', code), 'req-1');
      expect(problem).toMatchObject({ status: 500, code: 'INTERNAL', requestId: 'req-1' });
      expect(problem.detail).not.toContain('internal');
    }
  });

  it("points type at the code's catalog page", () => {
    expect(toProblem(new ConflictError('x', 'PASS_CONFLICT')).type).toBe(
      'https://passbook.mobile/developers/errors/PASS_CONFLICT',
    );
  });

  it('keeps subclasses distinct', () => {
    expect(new ConflictError().status).toBe(409);
  });
});
