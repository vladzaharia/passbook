import { describe, expect, it, vi } from 'vitest';
import { createFakeIdp } from '../../../../test/helpers/fake-idp.ts';
import { AppError } from '../../platform/errors.ts';
import type { Logger } from '../../platform/log.ts';
import { idpClient, idpConfigured } from './client.ts';
import { IDP_UNAVAILABLE_MESSAGE as UNAVAILABLE } from './errors.ts';
import { IDP_CODES, type WriteCtx } from './types.ts';

const ctx: WriteCtx = { ref: 'r', reason: 'test', actor: { kind: 'system', job: 'test' } };

// Every code the binding sends (design 5.10) and what a caller sees.
const MAP: [string, string, number, string][] = [
  ['IDP_AUTH', 'IDP_UNAVAILABLE', 503, UNAVAILABLE],
  ['IDP_UPSTREAM', 'IDP_UNAVAILABLE', 503, UNAVAILABLE],
  ['IDP_UNSAFE_CONFIG', 'IDP_UNAVAILABLE', 503, UNAVAILABLE],
  ['IDP_MISCONFIGURED', 'IDP_UNAVAILABLE', 503, UNAVAILABLE],
  ['IDP_DRIFT', 'IDP_UNAVAILABLE', 503, UNAVAILABLE],
  ['IDP_BREAKER', 'IDP_UNAVAILABLE', 503, UNAVAILABLE],
  ['IDP_BUDGET', 'IDP_BUDGET', 429, 'Too many Polaris ID setups today. Try again tomorrow.'],
  [
    'IDP_REFUSED',
    'IDP_REFUSED',
    403,
    "This Polaris ID can't take developer access here. Ask the PassBook owner.",
  ],
  ['IDP_NOT_FOUND', 'IDP_CONFLICT', 409, 'Polaris ID changed. Try again.'],
  ['IDP_CONFLICT', 'IDP_CONFLICT', 409, 'Polaris ID changed. Try again.'],
  ['IDP_FROZEN', 'IDP_FROZEN', 503, 'Polaris ID changes are paused. Ask the PassBook owner.'],
  ['IDP_NOT_MANAGED', 'IDP_NOT_MANAGED', 409, "PassBook doesn't manage this Polaris ID account."],
  ['IDP_SOMETHING_NEW', 'IDP_UNAVAILABLE', 503, UNAVAILABLE],
];

describe('idpClient', () => {
  it('covers every binding code', () => {
    const mapped = new Set(MAP.map(([from]) => from));
    for (const code of IDP_CODES) expect(mapped.has(code), code).toBe(true);
  });

  it.each(MAP)('maps %s', async (fromBinding, code, status, message) => {
    const idp = createFakeIdp();
    idp.failNext(fromBinding);
    const err = await idpClient({ IDP: idp.binding })
      .createSignup('member', ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code, status, message });
    expect(String((err as Error).message)).not.toContain('fake binding failure');
  });

  it('logs IDP_BREAKER as an error with its code', async () => {
    const error = vi.fn();
    const idp = createFakeIdp();
    idp.failNext('IDP_BREAKER');
    await idpClient({ IDP: idp.binding }, { error } as unknown as Logger)
      .lookup('s')
      .catch(() => undefined);
    expect(error).toHaveBeenCalledWith('idp.breaker', { code: 'IDP_BREAKER' });
  });

  it('hides an unclassified failure behind IDP_UNAVAILABLE', async () => {
    const rpc = { health: () => Promise.reject(new Error('socket closed')) };
    await expect(idpClient({ IDP: rpc }).health()).rejects.toMatchObject({
      code: 'IDP_UNAVAILABLE',
      status: 503,
      message: UNAVAILABLE,
    });
  });

  it('treats a missing binding as unavailable for every method', async () => {
    const client = idpClient({});
    expect(idpConfigured({})).toBe(false);
    expect(idpConfigured({ IDP: createFakeIdp().binding })).toBe(true);
    const calls = [
      client.health(),
      client.createSignup('member', ctx),
      client.deleteSignup('t', ctx),
      client.proveSignup(['t']),
      client.findByVerifiedEmail('a@b.c', ctx),
      client.lookup('s'),
      client.apply('s', { add: ['console'] }, ctx),
      client.setDisabled('s', true, ctx),
      client.snapshot(ctx),
      client.freeze('why', ctx),
      client.calls(0),
    ];
    for (const call of calls)
      await expect(call).rejects.toMatchObject({ code: 'IDP_UNAVAILABLE', status: 503 });
  });

  it('passes results through', async () => {
    const idp = createFakeIdp();
    const client = idpClient({ IDP: idp.binding });
    const signup = await client.createSignup('developer', ctx);
    if ('dryRun' in signup) throw new Error('expected a signup');
    expect(await client.proveSignup([signup.tokenId])).toBeNull();
    idp.completeSignup(signup.tokenId, 'sub-1');
    expect(await client.proveSignup([signup.tokenId])).toMatchObject({ subject: 'sub-1' });
    expect(await client.apply('sub-1', { remove: ['developer'] }, ctx)).toMatchObject({
      removed: ['developer'],
    });
  });
});
