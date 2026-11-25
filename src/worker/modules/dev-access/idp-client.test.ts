import { describe, expect, it } from 'vitest';
import { createFakeIdp } from '../../../../test/helpers/fake-idp.ts';
import { AppError } from '../../platform/errors.ts';
import { idpClient, idpConfigured } from './idp-client.ts';

const UNAVAILABLE = 'Polaris ID is not reachable. Try again in a few minutes.';

describe('idpClient', () => {
  // Every code the provisioner sends (dev-invite-design.md 3.6) and what a caller sees.
  it.each([
    ['IDP_AUTH', 'IDP_UNAVAILABLE', 503, UNAVAILABLE],
    ['IDP_UPSTREAM', 'IDP_UNAVAILABLE', 503, UNAVAILABLE],
    ['IDP_UNSAFE_CONFIG', 'IDP_UNAVAILABLE', 503, UNAVAILABLE],
    ['IDP_MISCONFIGURED', 'IDP_UNAVAILABLE', 503, UNAVAILABLE],
    ['IDP_DRIFT', 'IDP_UNAVAILABLE', 503, UNAVAILABLE],
    ['IDP_BUDGET', 'IDP_BUDGET', 429, 'Too many Polaris ID setups today. Try again tomorrow.'],
    [
      'IDP_REFUSED',
      'IDP_REFUSED',
      403,
      "This Polaris ID can't take developer access here. Ask the PassBook owner.",
    ],
    ['IDP_NOT_FOUND', 'IDP_CONFLICT', 409, 'Polaris ID changed. Try again.'],
    ['IDP_CONFLICT', 'IDP_CONFLICT', 409, 'Polaris ID changed. Try again.'],
    ['IDP_SOMETHING_NEW', 'IDP_UNAVAILABLE', 503, UNAVAILABLE],
  ])('maps %s', async (provisioner, code, status, message) => {
    const idp = createFakeIdp();
    idp.failNext(provisioner);
    const err = await idpClient({ IDP: idp.binding })
      .createSignup('ref')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code, status, message });
    expect(String((err as Error).message)).not.toContain('fake provisioner failure');
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
      client.createSignup('r'),
      client.deleteSignup('t'),
      client.proveSignup(['t']),
      client.addDeveloper('s', 'r'),
      client.removeDeveloper('s', 'removed'),
      client.calls(0),
    ];
    for (const call of calls)
      await expect(call).rejects.toMatchObject({ code: 'IDP_UNAVAILABLE', status: 503 });
  });

  it('passes results through', async () => {
    const idp = createFakeIdp();
    const client = idpClient({ IDP: idp.binding });
    const { tokenId } = await client.createSignup('inv-1');
    expect(await client.proveSignup([tokenId])).toBeNull();
    idp.completeSignup(tokenId, 'sub-1');
    expect(await client.proveSignup([tokenId])).toEqual({ tokenId, subject: 'sub-1' });
    expect(await client.removeDeveloper('sub-1', 'removed')).toBe('removed');
    expect(await client.removeDeveloper('sub-1', 'removed')).toBe('not_ours');
    expect(await client.addDeveloper('sub-2', 'inv-2')).toBe('added');
    expect(await client.addDeveloper('sub-2', 'inv-2')).toBe('already');
  });
});
