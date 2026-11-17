import { beforeAll, describe, expect, it } from 'vitest';
import { ScanSessionSchema } from '../../../shared/contracts/scan-session.ts';
import type { ScanActor } from './actor.ts';
import { scanReadAuthority, scanReadFence } from './repo-read-authority.ts';
import { scanningSessionsFixture } from './scanning-sessions-test-fixtures.ts';

/*
 * Row-level checks of the read relaxations (`pausedSession`, `stafflessMonitor`) through the
 * scanner's own counts read: the relaxed fence admits the legitimate state and still refuses once
 * the credential is gone.
 */
const fixture = scanningSessionsFixture();
beforeAll(fixture.setup);

describe('session read relaxations', () => {
  async function paired(surface: 'phone' | 'customer') {
    const { parent, device, pair, call } = fixture;
    const session = await parent(`Relaxed ${surface}`);
    const made = await device(session.id, `Relaxed ${surface} device`, surface);
    const headers = await pair(made.pairing?.code ?? '');
    const scanner = ScanSessionSchema.parse(
      await (await call('GET', '/scan/session', undefined, headers)).json(),
    ).scanner;
    if (!scanner) throw new Error('not paired');
    return { session, headers, scannerId: scanner.id };
  }

  it('a paused session still answers counts; a revoked scanner does not', async () => {
    const { call } = fixture;
    const { session, headers, scannerId } = await paired('phone');
    expect((await call('GET', '/scan/stats', undefined, headers)).status).toBe(200);
    const pause = await call('PATCH', `/scanning-sessions/${session.id}`, { status: 'paused' });
    expect(pause.status).toBe(200);
    expect((await call('GET', '/scan/stats', undefined, headers)).status).toBe(200);
    expect((await call('POST', `/scanners/${scannerId}/revoke`)).status).toBe(200);
    expect((await call('GET', '/scan/stats', undefined, headers)).status).toBe(401);
  });

  it('a staffless monitor reads its org logo path; a revoked one does not', async () => {
    const { call } = fixture;
    const { headers, scannerId } = await paired('customer');
    const logo = () => call('GET', '/scan/branding/logo', undefined, headers);
    // No logo is uploaded: 404 is the authorized answer, 401 or 409 would be a refusal.
    expect((await logo()).status).toBe(404);
    expect((await call('POST', `/scanners/${scannerId}/revoke`)).status).toBe(200);
    expect((await logo()).status).toBe(401);
  });
});

describe('relaxed read authority', () => {
  it('cannot be passed to a write guard', () => {
    // Type-level only: never called.
    const misuse = (actor: ScanActor) => {
      const strict = scanReadAuthority(actor, { now: 1 });
      scanReadFence(strict);
      const relaxed = scanReadAuthority(actor, { now: 1, read: { pausedSession: true } });
      // @ts-expect-error a relaxed fence is read-only
      scanReadFence(relaxed);
    };
    expect(typeof misuse).toBe('function');
  });
});
