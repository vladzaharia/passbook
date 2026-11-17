import { describe, expect, it } from 'vitest';
import { ForbiddenError } from '../../src/worker/platform/errors.ts';
import { expectProblem, expectRejectsCode } from './denial.ts';

const problem = (status: number, code: string) =>
  new Response(JSON.stringify({ code }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

// The bare toThrow() calls below mean "the helper failed": the message is vitest's own, not ours.
describe('denial helpers', () => {
  it('passes when status and code match and leaves the body readable', async () => {
    const res = problem(403, 'FORBIDDEN');
    await expectProblem(res, 403, 'FORBIDDEN');
    expect(await res.json()).toEqual({ code: 'FORBIDDEN' });
  });

  it('fails when the code differs although the status matches', async () => {
    await expect(
      expectProblem(problem(403, 'ORG_ACCESS_CHANGED'), 403, 'FORBIDDEN'),
    ).rejects.toThrow();
  });

  it('fails when the status differs although the code matches', async () => {
    await expect(expectProblem(problem(404, 'FORBIDDEN'), 403, 'FORBIDDEN')).rejects.toThrow();
  });

  it('matches a rejected AppError by code and rejects a different code', async () => {
    await expectRejectsCode(Promise.reject(new ForbiddenError()), 'FORBIDDEN');
    await expect(
      expectRejectsCode(Promise.reject(new ForbiddenError()), 'NOT_FOUND'),
    ).rejects.toThrow();
  });

  it('fails when the promise resolves', async () => {
    await expect(expectRejectsCode(Promise.resolve(1), 'FORBIDDEN')).rejects.toThrow();
  });
});
