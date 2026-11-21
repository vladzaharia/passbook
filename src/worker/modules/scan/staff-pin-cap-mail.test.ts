import { beforeAll, describe, expect, it, vi } from 'vitest';
import { makeScanStaff } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { staffSessionFixture } from './staff-session-test-fixtures.ts';

vi.mock('./pin-only-notice.ts', () => ({
  mailPinOnlyOff: () => Promise.resolve(),
  mailPinOrgCap: () => Promise.reject(new Error('mail is down')),
}));

const fixture = staffSessionFixture();
beforeAll(fixture.setup);

describe('the org cap alert', () => {
  it('leaves the 300th wrong PIN a wrong PIN when the mail path fails', async () => {
    const { kit, problem, signIn, settle } = fixture;
    const person = await makeScanStaff(kit.fx, { orgId: kit.org.id, pin: '270917' });
    const now = kit.clock.now();
    await run(kit.env.DB, 'INSERT INTO counters (key, window_start, count) VALUES (?, ?, 299)', [
      `scan:pinday-org:${kit.org.id}`,
      now - (now % 86_400_000),
    ]);
    const scanner = await kit.scanner({
      templateIds: [fixture.deskTemplate],
      settings: { staffSignIn: true },
    });
    await problem(await signIn(scanner.headers, person, '000000'), 400, 'PIN_INVALID');
    await settle();
    expect((await signIn(scanner.headers, person)).status).toBe(200);
  });
});
