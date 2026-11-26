import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ActionError,
  mintKey,
  reopenSandbox,
  sandboxOfOperation,
  startDelete,
  startRecreate,
  startReset,
} from './sandbox-actions.ts';

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
    for (const call of [() => startReset('c', 't'), () => reopenSandbox('c')]) {
      const error = await call().then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ActionError);
      expect((error as ActionError).signInUrl).toContain('/auth/oidc/start');
    }
  });

  it('a problem that is not a step-up has no link', async () => {
    answer(409, { code: 'SANDBOX_CLOSED', detail: 'The sandbox is closed. Reopen it first.' });
    const error = (await startReset('c', 't').catch((e: unknown) => e)) as ActionError;
    expect(error.signInUrl).toBeUndefined();
    expect(error.operationId).toBeUndefined();
  });

  it('start calls answer the operation the page follows', async () => {
    const operation = { id: 'op-1', kind: 'sandbox.reset', status: 'queued' };
    answer(202, { operation });
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(await startReset('c', 't')).toEqual(operation);
    expect(await startDelete('c')).toEqual(operation);
    expect(await startRecreate('c', 't')).toEqual(operation);
    expect(fetchMock.mock.calls.map((c) => [c[0], (c[1] as RequestInit).method])).toEqual([
      ['/api/v1/developer/sandbox/reset', 'POST'],
      ['/api/v1/developer/sandbox', 'DELETE'],
      ['/api/v1/developer/sandbox/recreate', 'POST'],
    ]);
  });

  it('names the operation already running, so the page follows it', async () => {
    answer(409, {
      code: 'OPERATION_RUNNING',
      detail: 'This is already running.',
      operationId: 'op-9',
    });
    const error = (await startDelete('c').catch((e: unknown) => e)) as ActionError;
    expect(error.operationId).toBe('op-9');
  });

  it('mints the key once: the secret, or null when it was shown already', async () => {
    answer(201, { key: { secret: 'pbp_test_x' } });
    expect(await mintKey('c')).toBe('pbp_test_x');
    answer(409, { code: 'SANDBOX_KEY_SHOWN', detail: 'Your key was shown once.' });
    expect(await mintKey('c')).toBeNull();
    answer(500, { code: 'X' });
    await expect(mintKey('c')).rejects.toBeInstanceOf(ActionError);
  });

  it('reads the sandbox a finished operation made from its result ids', () => {
    const op = {
      result: {
        href: null,
        ids: { sandboxId: 's', orgId: 'o', orgSlug: 'dev-1', templateId: 't' },
      },
    };
    expect(sandboxOfOperation(op as never)).toEqual({
      id: 's',
      orgId: 'o',
      orgSlug: 'dev-1',
      templateId: 't',
    });
    expect(sandboxOfOperation({ result: null } as never)).toBeNull();
  });
});
