import { afterEach, describe, expect, it } from 'vitest';
import { TURNSTILE_ACTION, TURNSTILE_JOIN_ACTION } from '../../../shared/turnstile.ts';
import { createLogger } from '../../platform/log.ts';
import { verifyTurnstile } from './turnstile.ts';

const env = { TURNSTILE_SECRET: 's', PUBLIC_BASE_URL: 'https://passbook.mobile' };
const lines: string[] = [];
const log = createLogger({}, { sink: (l) => lines.push(l) });
afterEach(() => {
  lines.length = 0;
});
const events = () => lines.map((l) => JSON.parse(l) as { event: string; code: string });

describe('verifyTurnstile', () => {
  it('fails closed and logs when fetch throws', async () => {
    const boom = (async () => {
      throw new Error('down');
    }) as unknown as typeof fetch;
    expect(await verifyTurnstile(env, 't', null, log, boom)).toBe(false);
    expect(events()).toEqual([
      expect.objectContaining({
        event: 'auth.turnstile_unavailable',
        code: 'TURNSTILE_UNAVAILABLE',
      }),
    ]);
  });

  it('fails closed and logs on an HTTP error', async () => {
    const bad = (async () => new Response('x', { status: 500 })) as unknown as typeof fetch;
    expect(await verifyTurnstile(env, 't', null, log, bad)).toBe(false);
    expect(events()[0]).toMatchObject({ code: 'TURNSTILE_UNAVAILABLE' });
  });

  it('fails closed and logs when the secret is missing', async () => {
    expect(
      await verifyTurnstile({ ...env, TURNSTILE_SECRET: undefined as never }, 't', null, log),
    ).toBe(false);
    expect(events()[0]).toMatchObject({
      event: 'auth.turnstile_unconfigured',
      code: 'TURNSTILE_UNCONFIGURED',
    });
  });

  it('passes a successful verdict', async () => {
    const ok = (async () =>
      Response.json({
        success: true,
        hostname: 'Passbook.mobile',
        action: 'magic_request',
      })) as unknown as typeof fetch;
    expect(await verifyTurnstile(env, 't', '1.2.3.4', log, ok)).toBe(true);
    expect(lines).toHaveLength(0);
  });

  it.each([
    ['another host', { success: true, hostname: 'evil.example' }],
    ['a missing host', { success: true, action: 'magic_request' }],
    [
      'a non-string host',
      { success: true, hostname: ['passbook.mobile'], action: 'magic_request' },
    ],
  ])('refuses a solved token with %s', async (_name, verdict) => {
    const fetchImpl = (async () => Response.json(verdict)) as unknown as typeof fetch;
    expect(await verifyTurnstile(env, 't', null, log, fetchImpl)).toBe(false);
    expect(events()[0]).toMatchObject({ code: 'TURNSTILE_HOSTNAME' });
  });

  it.each([
    ['another action', { success: true, hostname: 'passbook.mobile', action: 'contact' }],
    ['no action', { success: true, hostname: 'passbook.mobile' }],
  ])('refuses a solved token with %s', async (_name, verdict) => {
    const fetchImpl = (async () => Response.json(verdict)) as unknown as typeof fetch;
    expect(await verifyTurnstile(env, 't', null, log, fetchImpl)).toBe(false);
    expect(events()[0]).toMatchObject({ code: 'TURNSTILE_ACTION' });
  });

  it('refuses a failed verdict without a hostname check', async () => {
    const no = (async () =>
      Response.json({ success: false, hostname: 'passbook.mobile' })) as unknown as typeof fetch;
    expect(await verifyTurnstile(env, 't', null, log, no)).toBe(false);
    expect(lines).toHaveLength(0);
  });

  it("skips the host check only for Cloudflare's always-pass test secret", async () => {
    const test = (async () =>
      Response.json({ success: true, hostname: 'example.com' })) as unknown as typeof fetch;
    const secret = '1x0000000000000000000000000000000AA';
    expect(await verifyTurnstile({ ...env, TURNSTILE_SECRET: secret }, 't', null, log, test)).toBe(
      true,
    );
    expect(await verifyTurnstile(env, 't', null, log, test)).toBe(false);
  });
});

describe('verifyTurnstile action', () => {
  const verdict = (action: string) =>
    (async () =>
      Response.json({
        success: true,
        hostname: 'passbook.mobile',
        action,
      })) as unknown as typeof fetch;

  it('defaults to the sign-in action: a join token does not pass there', async () => {
    expect(await verifyTurnstile(env, 't', null, log, verdict(TURNSTILE_ACTION))).toBe(true);
    expect(await verifyTurnstile(env, 't', null, log, verdict(TURNSTILE_JOIN_ACTION))).toBe(false);
    expect(events().at(-1)).toMatchObject({ code: 'TURNSTILE_ACTION' });
  });

  it('takes the join action, and refuses a sign-in token there', async () => {
    const join = (f: typeof fetch) =>
      verifyTurnstile(env, 't', null, log, f, TURNSTILE_JOIN_ACTION);
    expect(await join(verdict(TURNSTILE_JOIN_ACTION))).toBe(true);
    expect(await join(verdict(TURNSTILE_ACTION))).toBe(false);
    expect(await join(verdict(''))).toBe(false);
  });

  it('still checks the hostname for the join action', async () => {
    const wrongHost = (async () =>
      Response.json({
        success: true,
        hostname: 'evil.example',
        action: 'join',
      })) as unknown as typeof fetch;
    expect(await verifyTurnstile(env, 't', null, log, wrongHost, TURNSTILE_JOIN_ACTION)).toBe(
      false,
    );
    expect(events().at(-1)).toMatchObject({ code: 'TURNSTILE_HOSTNAME' });
  });

  it('fails closed with no secret for the join action', async () => {
    expect(
      await verifyTurnstile(
        { ...env, TURNSTILE_SECRET: undefined as never },
        't',
        null,
        log,
        fetch,
        TURNSTILE_JOIN_ACTION,
      ),
    ).toBe(false);
  });
});
