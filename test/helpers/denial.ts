import { expect } from 'vitest';

type Refusal = Response | { status: number; json: unknown };

/**
 * Asserts a problem+json refusal: the status and the stable `code` (any of several for a loop over
 * endpoints). Reads a clone of a Response, so the body stays usable; takes `{ status, json }` too.
 */
export async function expectProblem(
  res: Refusal,
  status: number,
  code: string | readonly string[],
): Promise<void> {
  const body = (res instanceof Response ? await res.clone().json() : res.json) as {
    code?: string;
  } | null;
  const codes = typeof code === 'string' ? [code] : code;
  const actual = body?.code ?? '';
  expect({ status: res.status, code: actual }).toEqual({
    status,
    code: codes.includes(actual) ? actual : codes.join(' | '),
  });
}

/** Asserts a thrown AppError carries the stable `code` (not just that something threw). */
export async function expectRejectsCode(run: Promise<unknown>, code: string): Promise<void> {
  await expect(run).rejects.toMatchObject({ code });
}
