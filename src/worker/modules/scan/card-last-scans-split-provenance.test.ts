import { beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { scannerActor, withRole } from './actor.ts';
import { cardLastScans } from './card-last-scans.ts';
import { cardLastScansSplitFixture } from './card-last-scans-split-fixture.ts';
import { cardPrivacy } from './dto-projection.ts';
import { type CardHistoryRow, cardHistoryStmt } from './repo-card-history.ts';
import { getScanner } from './repo-device.ts';
import { candidateById } from './repo-lookup.ts';
import { readScannerScope } from './repo-scope.ts';
import { foundOf } from './resolve.ts';
import { makeLegacyScanPass, proofedScanActor, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;

beforeAll(async () => {
  kit = await setupScanKit();
});

const { act, approve, card, last, simple } = cardLastScansSplitFixture(() => kit);

describe('card last-scan privacy', () => {
  it('propagates a missing proof-key configuration instead of treating it as untrusted history', async () => {
    const { templateId, pass, scanner } = await simple();
    const scanId = await act(scanner.headers, pass.id);
    const scannerRow = await getScanner(kit.env.DB, scanner.id);
    const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
    if (!scannerRow || !candidate) throw new Error('Missing real card fixture');
    const scope = await readScannerScope(kit.env.DB, scannerRow, null);
    const actor = withRole(
      await proofedScanActor(kit.ctx, scannerActor(kit.ctx, scannerRow, 'live', 'cookie', scope)),
      null,
    );
    const found = await foundOf(kit.ctx, candidate, actor);
    if (!found) throw new Error('Missing evaluated card fixture');
    const result = await cardHistoryStmt(kit.env.DB, {
      orgId: kit.org.id,
      mode: 'live',
      passId: pass.id,
      templateId,
    }).all<CardHistoryRow>();
    expect(result.results.map((row) => row.id)).toEqual([scanId]);
    const env = Object.fromEntries(
      Object.entries(kit.env).filter(([name]) => !/^KEK_V\d+$/.test(name)),
    ) as typeof kit.env;
    await expect(
      cardLastScans(
        { ...kit.ctx, env },
        actor,
        found,
        cardPrivacy(found, actor),
        { scans: result.results, undoWindowMinutes: 10 },
        kit.clock.now(),
      ),
    ).rejects.toThrow('No KEK configured');
  });

  it('requires an unambiguous action and same-template current source for historical labels', async () => {
    const { templateId, pass, scanner } = await simple();
    const scanId = await act(scanner.headers, pass.id);
    const scannerRow = await getScanner(kit.env.DB, scanner.id);
    const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
    if (!scannerRow || !candidate) throw new Error('Missing real card fixture');
    const scope = await readScannerScope(kit.env.DB, scannerRow, null);
    const actor = withRole(
      await proofedScanActor(kit.ctx, scannerActor(kit.ctx, scannerRow, 'live', 'cookie', scope)),
      null,
    );
    const found = await foundOf(kit.ctx, candidate, actor);
    const action = found?.scan.actions[0];
    if (!found || !action) throw new Error('Missing evaluated card action');
    const ambiguous = {
      ...found,
      scan: { ...found.scan, actions: [...found.scan.actions, action] },
    };
    const result = await cardHistoryStmt(kit.env.DB, {
      orgId: kit.org.id,
      mode: 'live',
      passId: pass.id,
      templateId,
    }).all<CardHistoryRow>();
    expect(result.results.map((row) => row.id)).toEqual([scanId]);
    const scans = await cardLastScans(
      kit.ctx,
      actor,
      ambiguous,
      cardPrivacy(ambiguous, actor),
      { scans: result.results, undoWindowMinutes: 10 },
      kit.clock.now(),
    );
    expect(scans).toEqual({ scans: [], selectedScans: [] });
    const foreignPolicy = {
      ...found,
      activePolicy: { ...(found.activePolicy ?? found.template), id: 'other-template' },
    };
    const foreignScans = await cardLastScans(
      kit.ctx,
      actor,
      foreignPolicy,
      cardPrivacy(foreignPolicy, actor),
      { scans: result.results, undoWindowMinutes: 10 },
      kit.clock.now(),
    );
    expect(foreignScans).toEqual({ scans: [], selectedScans: [] });
    const missingKeyset = { ...found, credentialKeysetCommitment: '' };
    const redacted = await cardLastScans(
      kit.ctx,
      actor,
      missingKeyset,
      cardPrivacy(missingKeyset, actor),
      { scans: result.results, undoWindowMinutes: 10 },
      kit.clock.now(),
    );
    expect(redacted).toEqual({ scans: [], selectedScans: [] });
    const row = result.results[0];
    if (!row) throw new Error('Expected scoped card history');
    const mismatched: CardHistoryRow[] = [
      { ...row, org_id: 'other-org' },
      { ...row, mode: 'test' },
      { ...row, pass_id: 'other-pass' },
      { ...row, template_id: 'other-template' },
    ];
    expect(
      await cardLastScans(
        kit.ctx,
        actor,
        found,
        cardPrivacy(found, actor),
        { scans: mismatched, undoWindowMinutes: 10 },
        kit.clock.now(),
      ),
    ).toEqual({ scans: [], selectedScans: [] });
    expect(
      await cardLastScans(
        kit.ctx,
        { ...actor, orgId: 'other-org' },
        found,
        cardPrivacy(found, actor),
        { scans: [{ ...row, org_id: 'other-org' }], undoWindowMinutes: 10 },
        kit.clock.now(),
      ),
    ).toEqual({ scans: [], selectedScans: [] });
  });

  it.each([
    'missing event',
    'unsigned event',
    'missing projection',
    'missing commitment',
    'malformed authority',
    'action mismatch',
    'release hash mismatch',
    'event MAC mismatch',
    'personalization mismatch',
  ] as const)('omits historical rows when the approved provenance has a %s', async (mutation) => {
    const { pass, scanner } = await simple('Verified entry');
    const scanId = await act(scanner.headers, pass.id);
    expect(last(await card(scanner.headers, pass.id), scanId).actionLabel).toBe('Verified entry');
    if (mutation === 'missing event') {
      await run(
        kit.env.DB,
        "DELETE FROM pass_events WHERE pass_id=? AND json_extract(data,'$.scanId')=?",
        [pass.id, scanId],
      );
    } else if (
      mutation === 'unsigned event' ||
      mutation === 'missing projection' ||
      mutation === 'missing commitment'
    ) {
      const path =
        mutation === 'unsigned event'
          ? '$.authority.eventProof'
          : mutation === 'missing projection'
            ? '$.authority.eventProjection'
            : '$.authority.evaluatedPersonalizationHash';
      await run(
        kit.env.DB,
        `UPDATE pass_events SET data=json_remove(data,?)
          WHERE pass_id=? AND json_extract(data,'$.scanId')=?`,
        [path, pass.id, scanId],
      );
    } else if (mutation === 'personalization mismatch') {
      await run(
        kit.env.DB,
        `UPDATE pass_versions SET personalization=json_set(personalization,'$.memberName','Changed')
          WHERE pass_id=? AND version=(SELECT json_extract(data,'$.authority.walletVersion') FROM pass_events
            WHERE pass_id=? AND json_extract(data,'$.scanId')=?)`,
        [pass.id, pass.id, scanId],
      );
      await run(
        kit.env.DB,
        "UPDATE passes SET personalization=json_set(personalization,'$.memberName','Other') WHERE id=?",
        [pass.id],
      );
    } else {
      const path =
        mutation === 'malformed authority'
          ? '$.authority'
          : mutation === 'action mismatch'
            ? '$.actionId'
            : mutation === 'release hash mismatch'
              ? '$.authority.activeReleaseCandidateHash'
              : '$.authority.eventProof.mac';
      await run(
        kit.env.DB,
        `UPDATE pass_events SET data=json_set(data,?,?)
          WHERE pass_id=? AND json_extract(data,'$.scanId')=?`,
        [path, 'tampered', pass.id, scanId],
      );
    }
    expect(
      (await card(scanner.headers, pass.id)).lastScans.find((row) => row.scanId === scanId),
    ).toBeUndefined();
  });

  it('verifies the real legacy MAC across a later approved head and rejects tampering', async () => {
    const templateId = await kit.scanTemplate(
      'Legacy history',
      {
        actions: [{ id: 'enter', label: 'Legacy entry', kind: 'check_in' }],
      },
      { releaseModes: [] },
    );
    const template = await kit.registry.resolve(templateId);
    const pass = await makeLegacyScanPass(kit.fx, { orgId: kit.org.id, template });
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const scanId = await act(scanner.headers, pass.id);
    expect(last(await card(scanner.headers, pass.id), scanId).actionLabel).toBe('Legacy entry');
    await approve(templateId, template.version);
    expect(last(await card(scanner.headers, pass.id), scanId).actionLabel).toBe('Legacy entry');
    await run(
      kit.env.DB,
      `UPDATE pass_events SET data=json_set(data,'$.authority.eventProof.mac',?)
      WHERE pass_id=? AND json_extract(data,'$.scanId')=?`,
      ['0'.repeat(64), pass.id, scanId],
    );
    expect(
      (await card(scanner.headers, pass.id)).lastScans.find((row) => row.scanId === scanId),
    ).toBeUndefined();
  });

  it.each(['approved', 'legacy'] as const)(
    'requires the stored scan actor to match the signed %s receipt',
    async (kind) => {
      const templateId = await kit.scanTemplate(
        'Card actor provenance',
        {
          actions: [{ id: 'enter', label: 'Proven entry', kind: 'check_in' }],
        },
        kind === 'legacy' ? { releaseModes: [] } : {},
      );
      const template = await kit.registry.resolve(templateId);
      const pass =
        kind === 'legacy'
          ? await makeLegacyScanPass(kit.fx, { orgId: kit.org.id, template })
          : await kit.scanPass(templateId);
      const scanner = await kit.scanner({ templateIds: [templateId] });
      const other = await kit.scanner({ templateIds: [templateId] });
      await run(kit.env.DB, 'UPDATE scanners SET name=? WHERE id=?', ['Proven lobby', scanner.id]);
      const scanId = await act(scanner.headers, pass.id);
      expect(last(await card(scanner.headers, pass.id), scanId)).toMatchObject({
        actionLabel: 'Proven entry',
        scannerName: 'Proven lobby',
        undoable: true,
      });

      // Keep actor_key and scanner_id untouched so only the exact actor-id proof catches this.
      await run(kit.env.DB, 'UPDATE scans SET actor_id=? WHERE id=?', [other.id, scanId]);
      expect(
        (await card(scanner.headers, pass.id)).lastScans.find((row) => row.scanId === scanId),
      ).toBeUndefined();
    },
  );
});
