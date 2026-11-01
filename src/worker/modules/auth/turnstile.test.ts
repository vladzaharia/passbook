import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../platform/log.ts';
import { verifyTurnstile } from './turnstile.ts';

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
    expect(await verifyTurnstile({ TURNSTILE_SECRET: 's' }, 't', null, log, boom)).toBe(false);
    expect(events()).toEqual([
      expect.objectContaining({
        event: 'auth.turnstile_unavailable',
        code: 'TURNSTILE_UNAVAILABLE',
      }),
    ]);
  });

  it('fails closed and logs on an HTTP error', async () => {
    const bad = (async () => new Response('x', { status: 500 })) as unknown as typeof fetch;
    expect(await verifyTurnstile({ TURNSTILE_SECRET: 's' }, 't', null, log, bad)).toBe(false);
    expect(events()[0]).toMatchObject({ code: 'TURNSTILE_UNAVAILABLE' });
  });

  it('fails closed and logs when the secret is missing', async () => {
    expect(await verifyTurnstile({ TURNSTILE_SECRET: undefined as never }, 't', null, log)).toBe(
      false,
    );
    expect(events()[0]).toMatchObject({
      event: 'auth.turnstile_unconfigured',
      code: 'TURNSTILE_UNCONFIGURED',
    });
  });

  it('passes a successful verdict', async () => {
    const ok = (async () => Response.json({ success: true })) as unknown as typeof fetch;
    expect(await verifyTurnstile({ TURNSTILE_SECRET: 's' }, 't', '1.2.3.4', log, ok)).toBe(true);
    expect(lines).toHaveLength(0);
  });
});
