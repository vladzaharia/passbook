import { beforeAll, describe, expect, it } from 'vitest';
import { makeScanner, makeScanStaff } from '../../../../test/helpers/index.ts';
import { auditStmt } from '../audit/repo.ts';
import { type RetentionKit, retentionKit } from '../retention/retention-test-fixtures.ts';
import { dailyPinDigest } from './pin-digest.ts';

let rk: RetentionKit;
beforeAll(async () => {
  rk = await retentionKit();
});

describe('the daily PIN digest', () => {
  it('names the person and the scanner, once a day per org', async () => {
    const { kit } = rk;
    const { orgId, email } = await rk.org();
    const person = await makeScanStaff(kit.fx, { orgId, name: 'Dana Digest', pin: '482917' });
    const scanner = await makeScanner(kit.fx, { orgId });
    const db = kit.env.DB;
    await db.batch(
      ['scan_staff.pin_shared', 'scan_staff.pin_self_reset'].map((action) =>
        auditStmt(db, kit.ctx, {
          orgId,
          actorType: 'scanner',
          actorId: scanner.id,
          action,
          targetType: 'scan_staff',
          targetId: person.id,
        }),
      ),
    );
    kit.clock.advance(24 * 3_600_000);
    await dailyPinDigest(kit.ctx);
    await dailyPinDigest(kit.ctx);
    const sent = rk.mail.filter((m) => m.subject.includes('PIN activity'));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(email);
    expect(sent[0]?.text).toContain('Dana Digest');
    expect(sent[0]?.text).toContain(`seen on Scanner`);
    expect(sent[0]?.text).not.toMatch(/\b\d{6}\b/);
  });
});
