import { beforeAll, describe, expect, it } from 'vitest';
import { type RetentionKit, retentionKit } from '../retention/retention-test-fixtures.ts';
import { mailPinOnlyOff } from './pin-only-notice.ts';

let rk: RetentionKit;
beforeAll(async () => {
  rk = await retentionKit();
});
const sent = () => rk.mail.filter((m) => m.subject.includes('PIN-only'));

describe('the PIN-only lockout mail', () => {
  it('goes to the org admins once a day, however often it is asked for', async () => {
    const { orgId, email } = await rk.org();
    await mailPinOnlyOff(rk.kit.ctx, orgId);
    await mailPinOnlyOff(rk.kit.ctx, orgId);
    expect(sent().map((m) => m.to)).toEqual([email]);
    expect(sent()[0]?.text).not.toMatch(/\d{6}/);
    rk.kit.clock.advance(24 * 3_600_000);
    await mailPinOnlyOff(rk.kit.ctx, orgId);
    expect(sent()).toHaveLength(2);
  });
});
