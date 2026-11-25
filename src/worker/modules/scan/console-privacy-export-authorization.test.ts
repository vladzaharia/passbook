import { describe, expect, it } from 'vitest';
import { expectRejectsCode } from '../../../../test/helpers/denial.ts';
import { expectSet } from '../../../../test/helpers/landed.ts';
import { first, run } from '../../platform/db.ts';
import { afterBatch, beforeBatch } from './batch-interceptor-test-support.ts';
import { recordedCheckIn, recordedNoMatch } from './console-privacy-actions-test-fixtures.ts';
import {
  adminMembershipId,
  adminSessionId,
  exportPath,
  get,
  kit,
  PUBLIC,
  privatePass,
  setupPrivacyKit,
  templateId,
} from './console-privacy-test-fixtures.ts';

setupPrivacyKit();

const revoke = (revoked: 'membership' | 'session') => async (db: D1Database) => {
  const sql =
    revoked === 'membership'
      ? 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?'
      : 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?';
  const id = revoked === 'membership' ? adminMembershipId : adminSessionId;
  await run(db, sql, [kit.clock.now(), id]);
  await expectSet(
    db,
    revoked === 'membership' ? 'org_memberships' : 'sessions',
    revoked === 'membership' ? 'id' : 'id_hash',
    id,
  );
};

describe('scan console and feed privacy', () => {
  it.each(['membership', 'session'] as const)(
    'does not commit an export audit when its %s is revoked after counting',
    async (revoked) => {
      const scanner = await kit.scanner({ templateIds: [templateId] });
      await recordedNoMatch(scanner);
      const { result: response, fired } = await afterBatch(
        kit.env,
        /SELECT\s+count\(\*\)\s+AS\s+n\s+FROM\s+\(SELECT\s+1\s+FROM\s+scans\s+s/i,
        revoke(revoked),
        () => get(exportPath()),
      );
      expect(fired).toBe(true);
      expect(response.status).toBe(403);
      expect(
        await first(kit.env.DB, "SELECT id FROM audit_log WHERE action = 'scan.export'"),
      ).toBeNull();
    },
  );

  it.each(['membership', 'session'] as const)(
    'does not stream a projected row when its %s is revoked before a page is read',
    async (revoked) => {
      const scanner = await kit.scanner({ templateIds: [templateId] });
      const pass = await privatePass();
      await recordedCheckIn(scanner, pass.id);
      const { result, fired } = await beforeBatch(
        kit.env,
        /page AS MATERIALIZED/,
        revoke(revoked),
        async () => {
          const response = await get(exportPath());
          expect(response.status).toBe(200);
          if (!response.body) throw new Error('Export must have a response body.');
          const reader = response.body.getReader();
          const header = await reader.read();
          expect(header.done).toBe(false);
          const text = new TextDecoder().decode(header.value);
          expect(text).toContain('Time (UTC)');
          expect(text).not.toContain(PUBLIC);
          await expectRejectsCode(reader.read(), 'FORBIDDEN');
          return text;
        },
      );
      expect(fired).toBe(true);
      expect(result).not.toContain(PUBLIC);
    },
  );

  it('streams every page of the snapshot it started from', async () => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const pass = await privatePass();
    await recordedCheckIn(scanner, pass.id);
    const response = await get(exportPath());
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain(PUBLIC);
  });
});
