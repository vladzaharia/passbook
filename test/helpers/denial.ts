import { expect } from 'vitest';

/** Asserts a problem+json refusal: the status and the stable `code`. Reads a clone, so the body stays usable. */
export async function expectProblem(res: Response, status: number, code: string): Promise<void> {
  const body = (await res.clone().json()) as { code?: string };
  expect({ status: res.status, code: body.code }).toEqual({ status, code });
}

/** Asserts a thrown AppError carries the stable `code` (not just that something threw). */
export async function expectRejectsCode(run: Promise<unknown>, code: string): Promise<void> {
  await expect(run).rejects.toMatchObject({ code });
}
