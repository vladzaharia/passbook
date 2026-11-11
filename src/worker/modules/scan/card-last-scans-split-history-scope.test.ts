import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { requireApprovedRelease } from '../templates/releases.ts';
import { cardLastScansSplitFixture } from './card-last-scans-split-fixture.ts';
import { cardHistoryStmt } from './repo-card-history.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;

beforeAll(async () => {
  kit = await setupScanKit();
});

const { act, card, simple } = cardLastScansSplitFixture(() => kit);

describe('card last-scan privacy', () => {
  it.each(['email', 'url', 'pass secret', 'foreign scanner'] as const)(
    'shows a scan with a %s scanner name as Scanner, or omits it for a foreign scanner, without leaking it',
    async (kind) => {
      const { pass, scanner } = await simple();
      const scanId = await act(scanner.headers, pass.id);
      let secret: string;
      if (kind === 'foreign scanner') {
        const org = await makeOrg(kit.fx);
        const foreign = await kit.scanner({ orgId: org.id });
        secret = 'Foreign lobby';
        await run(kit.env.DB, 'UPDATE scanners SET name=? WHERE id=?', [secret, foreign.id]);
        await run(kit.env.DB, 'UPDATE scans SET scanner_id=? WHERE id=?', [foreign.id, scanId]);
      } else {
        secret =
          kind === 'email'
            ? 'private.person@example.com'
            : kind === 'url'
              ? 'https://private.example/path'
              : pass.serial;
        await run(kit.env.DB, 'UPDATE scanners SET name=? WHERE id=?', [secret, scanner.id]);
      }
      const projected = await card(scanner.headers, pass.id);
      const row = projected.lastScans.find((item) => item.scanId === scanId);
      // A scanner of another organization is tenant isolation, not a name to hide: the scan is excluded.
      if (kind === 'foreign scanner') expect(row).toBeUndefined();
      else expect(row).toMatchObject({ scannerName: 'Scanner' });
      expect(JSON.stringify(projected.lastScans)).not.toContain(secret);
    },
  );

  it('shows a scan by a deleted scanner as Scanner rather than inventing its name', async () => {
    const { templateId, pass, scanner } = await simple();
    const scanId = await act(scanner.headers, pass.id);
    const reader = await kit.scanner({ templateIds: [templateId] });
    await run(kit.env.DB, 'DELETE FROM scanners WHERE id=?', [scanner.id]);
    expect(
      (await card(reader.headers, pass.id)).lastScans.find((row) => row.scanId === scanId),
    ).toMatchObject({ scannerName: 'Scanner' });
  });

  it.each(['mode', 'template', 'organization'] as const)(
    'excludes card history when the pass pins a release from another %s scope',
    async (scope) => {
      const { templateId, pass, scanner } = await simple();
      const scanId = await act(scanner.headers, pass.id);
      const statement = cardHistoryStmt(kit.env.DB, {
        orgId: kit.org.id,
        mode: 'live',
        passId: pass.id,
        templateId,
      });
      expect((await statement.all<{ id: string }>()).results.map((row) => row.id)).toEqual([
        scanId,
      ]);
      let releaseId: string;
      if (scope === 'mode') {
        releaseId = (await requireApprovedRelease(kit.ctx, templateId, kit.org.id, 'test', 'apple'))
          .id;
      } else {
        const orgId = scope === 'organization' ? (await makeOrg(kit.fx)).id : kit.org.id;
        const otherTemplate = await kit.scanTemplate(
          'Other release scope',
          {
            actions: [{ id: 'enter', label: 'Admit member', kind: 'check_in' }],
          },
          { orgId },
        );
        releaseId = (await requireApprovedRelease(kit.ctx, otherTemplate, orgId, 'live', 'apple'))
          .id;
      }
      await run(kit.env.DB, 'UPDATE passes SET release_id=? WHERE id=?', [releaseId, pass.id]);
      expect((await statement.all<{ id: string }>()).results).toEqual([]);
    },
  );

  it('excludes a foreign scanner reference before selecting the latest three scans', async () => {
    const templateId = await kit.scanTemplate('History scope', {
      actions: [{ id: 'enter', label: 'Admit member', kind: 'check_in', repeat: 'always' }],
    });
    const pass = await kit.scanPass(templateId);
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(await act(scanner.headers, pass.id));
      kit.clock.advance(1);
    }
    const foreignOrg = await makeOrg(kit.fx);
    const foreign = await kit.scanner({ orgId: foreignOrg.id });
    await run(kit.env.DB, 'UPDATE scans SET scanner_id=? WHERE id=?', [foreign.id, ids[3]!]);
    const scans = (await card(scanner.headers, pass.id)).lastScans;
    expect(scans.map((row) => row.scanId)).toEqual([ids[2], ids[1], ids[0]]);
    expect(scans.every((row) => row.actionLabel === 'Admit member')).toBe(true);
  });

  it('permanently excludes quarantined scans before selecting the latest three', async () => {
    const templateId = await kit.scanTemplate('Quarantined card history', {
      actions: [{ id: 'enter', label: 'Admit member', kind: 'check_in', repeat: 'always' }],
    });
    const pass = await kit.scanPass(templateId);
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const scanId = await act(scanner.headers, pass.id);
    const query = { orgId: kit.org.id, mode: 'live' as const, passId: pass.id, templateId };
    expect((await cardHistoryStmt(kit.env.DB, query).all<{ id: string }>()).results).toEqual([
      expect.objectContaining({ id: scanId }),
    ]);
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined=1 WHERE id=?', [pass.id]);
    expect(
      await first(kit.env.DB, 'SELECT scan_id FROM scan_quarantine_exclusions WHERE scan_id=?', [
        scanId,
      ]),
    ).toEqual({ scan_id: scanId });
    expect((await cardHistoryStmt(kit.env.DB, query).all()).results).toEqual([]);
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined=0 WHERE id=?', [pass.id]);
    expect((await cardHistoryStmt(kit.env.DB, query).all()).results).toEqual([]);

    const fresh: string[] = [];
    for (let i = 0; i < 3; i++) {
      kit.clock.advance(1);
      fresh.push(await act(scanner.headers, pass.id));
    }
    // An excluded newest row must not consume one of the three available slots.
    await run(kit.env.DB, 'UPDATE scans SET at=? WHERE id=?', [kit.clock.now() + 1000, scanId]);
    const rows = (await cardHistoryStmt(kit.env.DB, query).all<{ id: string }>()).results;
    expect(rows.map((row) => row.id)).toEqual([fresh[2], fresh[1], fresh[0]]);
    expect((await card(scanner.headers, pass.id)).lastScans.map((row) => row.scanId)).toEqual([
      fresh[2],
      fresh[1],
      fresh[0],
    ]);
  });

  it.each(['soft', 'hard'] as const)(
    'does not attach %s-deleted pass history to a current card',
    async (deletion) => {
      const { templateId, pass, scanner } = await simple();
      const scanId = await act(scanner.headers, pass.id);
      const query = { orgId: kit.org.id, mode: 'live' as const, passId: pass.id, templateId };
      if (deletion === 'soft') {
        await run(kit.env.DB, 'UPDATE passes SET deleted_at=? WHERE id=?', [
          kit.clock.now(),
          pass.id,
        ]);
      } else {
        await run(kit.env.DB, 'DELETE FROM passes WHERE id=?', [pass.id]);
        expect(await first(kit.env.DB, 'SELECT pass_id FROM scans WHERE id=?', [scanId])).toEqual({
          pass_id: null,
        });
      }
      expect((await cardHistoryStmt(kit.env.DB, query).all()).results).toEqual([]);
      const other = await kit.scanPass(templateId);
      expect(
        (await cardHistoryStmt(kit.env.DB, { ...query, passId: other.id }).all()).results,
      ).toEqual([]);
    },
  );
});
