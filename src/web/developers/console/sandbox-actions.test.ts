import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionError, reopenSandbox, resetSandbox } from './sandbox-actions.ts';

afterEach(() => vi.unstubAllGlobals());

const answer = (status: number, body: unknown) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );

describe('sandbox actions', () => {
  it('carries the Polaris ID link of a step-up answer, for Reset and Reopen', async () => {
    answer(403, {
      code: 'STEP_UP_REQUIRED',
      detail: 'Sign in again to continue.',
      signInUrl: '/auth/oidc/start?prompt=login&max_age=0&next=%2Fdevelopers',
    });
    for (const call of [() => resetSandbox('c', 't'), () => reopenSandbox('c')]) {
      const error = await call().then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ActionError);
      expect((error as ActionError).signInUrl).toContain('/auth/oidc/start');
    }
  });

  it('a problem that is not a step-up has no link; an unfinished reset says more and has no key', async () => {
    answer(409, { code: 'SANDBOX_CLOSED', detail: 'The sandbox is closed. Reopen it first.' });
    const error = (await resetSandbox('c', 't').catch((e: unknown) => e)) as ActionError;
    expect(error.signInUrl).toBeUndefined();
    answer(200, {
      sandbox: { id: 's', orgSlug: 'o', templateId: null },
      key: null,
      deleted: { passes: 4, captures: 0, calls: 0, other: 0 },
      kept: 0,
      more: true,
      resetsLeft: 2,
    });
    const out = await resetSandbox('c', 't');
    expect(out).toMatchObject({ more: true, secret: null, resetsLeft: 2 });
  });
});
