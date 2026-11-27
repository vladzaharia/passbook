import { describe, expect, it } from 'vitest';
import { makeEnv } from '../../../../test/helpers/index.ts';
import { createMtlsApnsTransport } from './apns.ts';

describe('mtls apns transport', () => {
  it('keeps the error name in the reason of a thrown fetch', async () => {
    const env = await makeEnv();
    const fetcher = {
      fetch: async () => {
        throw new TypeError('network down');
      },
    };
    Object.assign(env, { APNS_TEST: fetcher });
    const transport = createMtlsApnsTransport(env);
    const [result] = await transport.send(
      { passTypeIdentifier: 'pass.test', apnsBinding: 'APNS_TEST' },
      ['tok'],
      0,
    );
    expect(result).toEqual({ token: 'tok', status: 0, reason: 'NetworkError:TypeError' });
  });

  it('drains the body of a successful response', async () => {
    const env = await makeEnv();
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    Object.assign(env, { APNS_TEST: { fetch: async () => new Response(body, { status: 200 }) } });
    const [result] = await createMtlsApnsTransport(env).send(
      { passTypeIdentifier: 'pass.test', apnsBinding: 'APNS_TEST' },
      ['tok'],
      0,
    );
    expect(result?.status).toBe(200);
    expect(cancelled).toBe(true);
  });

  it('sends the pass id as apns-collapse-id', async () => {
    const env = await makeEnv();
    let sent: Headers | undefined;
    Object.assign(env, {
      APNS_TEST: {
        fetch: async (_url: string, init: RequestInit) => {
          sent = new Headers(init.headers);
          return new Response(null, { status: 200 });
        },
      },
    });
    const target = { passTypeIdentifier: 'pass.test', apnsBinding: 'APNS_TEST' };
    const transport = createMtlsApnsTransport(env);
    await transport.send({ ...target, collapseId: 'pass-1' }, ['tok'], 0);
    expect(sent?.get('apns-collapse-id')).toBe('pass-1');
    await transport.send(target, ['tok'], 0);
    expect(sent?.has('apns-collapse-id')).toBe(false);
  });
});
