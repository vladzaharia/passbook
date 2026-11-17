import { beforeAll, describe, expect, it } from 'vitest';
import { stagePendingCredentialTransfer } from '../../../../test/helpers/credential-transfer.ts';
import { run } from '../../platform/db.ts';
import { candidateById } from './repo-lookup.ts';
import { outputAuthorityPredicate } from './repo-output-authority.ts';
import { CHECK_IN, policyRevisionHelpers } from './repo-policy-revision-test-fixtures.ts';
import { foundOf } from './resolve.ts';
import { prepareDisplayHistory } from './scan-display-history.ts';
import { key, type ScanKit, setupScanKit, startScanCredentialTransfer } from './test-kit.ts';

let kit: ScanKit;
const { scenario, requestOf } = policyRevisionHelpers(() => kit);
beforeAll(async () => {
  kit = await setupScanKit();
});

const NEEDS = { history: ['visits', 'scans'], ledger: [] };

/** A pass with one signed check-in, and the pieces to read its display history at will. */
async function checkedIn() {
  const s = await scenario();
  const result = (await (
    await kit.post(s.scanner.headers, '/actions', { ...requestOf(s.pass.id), actionId: 'auto' })
  ).json()) as { kind: string; scanId: string | null };
  expect(result.kind).toBe('ok');
  const read = async (between?: () => Promise<void>) => {
    const candidate = await candidateById(kit.env.DB, kit.org.id, s.pass.id);
    if (!candidate) throw new Error('Missing candidate');
    const found = await foundOf(kit.ctx, candidate, s.actor);
    if (!found) throw new Error('Missing authorized pass');
    const now = kit.clock.now();
    const authority = outputAuthorityPredicate({
      actor: s.actor,
      event: s.actor.event,
      now,
      templateId: found.pass.templateId,
      pass: candidate.pass,
      connectionGeneration: candidate.connectionGeneration,
      activeTemplateVersion: candidate.activeTemplateVersion,
      orgRevision: candidate.orgRevision,
      templateRevision: candidate.templateRevision,
      release: candidate,
      displayTemplateVersion: candidate.displayTemplateVersion,
      checkInRules: candidate.checkInRules,
      lookupHash: candidate.lookupHash,
      requireActive: true,
      credentialTombstoneRefs: [],
      credentialKeysetCommitment: candidate.credentialKeysetCommitment,
    });
    await between?.();
    // The read, then (a caller's window for a race), then the final batch.
    const plan = await prepareDisplayHistory(kit.ctx, s.actor, found, NEEDS);
    return {
      finalize: async () => {
        const bound = plan.bind(now, authority);
        return bound.finalize(await kit.env.DB.batch(bound.stmts));
      },
    };
  };
  return { ...s, scanId: result.scanId, read };
}

const listed = (value: unknown) =>
  ((value as { list?: { scans?: unknown[] } } | undefined)?.list?.scans ?? []).length;

describe('display history denials', () => {
  it('lists the check-in of an unchanged pass (positive control)', async () => {
    const s = await checkedIn();
    const history = await (await s.read()).finalize();
    expect(history?.value).toMatchObject({
      scans: { total: 1 },
      visits: { total: 1 },
      list: { scans: [{ label: 'Check in', where: s.actor.scanner?.name }] },
    });
  });

  it('names the scanner generically once it was renamed before the read', async () => {
    const s = await checkedIn();
    await run(kit.env.DB, 'UPDATE scanners SET name=? WHERE id=?', [
      `Renamed ${key()}`,
      s.scanner.id,
    ]);
    const history = await (await s.read()).finalize();
    expect(history?.value).toMatchObject({ list: { scans: [{ where: 'Scanner' }] } });
  });

  it('keeps the read name when the scanner is renamed after the read', async () => {
    const s = await checkedIn();
    const read = await s.read();
    await run(kit.env.DB, 'UPDATE scanners SET name=? WHERE id=?', [
      `Renamed ${key()}`,
      s.scanner.id,
    ]);
    expect((await read.finalize())?.value).toMatchObject({
      list: { scans: [{ where: s.actor.scanner?.name }] },
    });
    // The next read shows the rename.
    const next = await s.read();
    expect((await next.finalize())?.value).toMatchObject({
      list: { scans: [{ where: 'Scanner' }] },
    });
  });

  it('lists nothing when the signed event changed before the read', async () => {
    const s = await checkedIn();
    await run(
      kit.env.DB,
      "UPDATE pass_events SET data=json_set(data,'$.authority.role','manager') WHERE pass_id=?",
      [s.pass.id],
    );
    const value = (await (await s.read()).finalize())?.value;
    expect(value).toMatchObject({ scans: { total: 1 } });
    expect(listed(value)).toBe(0);
    expect(value).not.toHaveProperty('visits');
  });

  it('lists no scan of a pass with a credential transfer pending, before or after the read', async () => {
    for (const when of ['before', 'after'] as const) {
      const s = await checkedIn();
      const transfer = () =>
        stagePendingCredentialTransfer(kit.env.DB, s.pass.id, {
          id: key(),
          token: key(),
          now: kit.clock.now(),
          targetHolderEmail: 'next@example.test',
        });
      const read = await s.read(when === 'before' ? transfer : undefined);
      if (when === 'after') await transfer();
      // Either the caller's own authority refuses the batch or the lineage check hides every row.
      expect(listed((await read.finalize())?.value)).toBe(0);
    }
  });

  it('keeps its listed scan but claims no visit total when the count moved after the read', async () => {
    const s = await checkedIn();
    kit.clock.advance(1_000);
    const read = await s.read();
    // A scan that reached the server late, dated just after the first one.
    const prefix = key();
    await run(
      kit.env.DB,
      `INSERT INTO scans (id,org_id,mode,pass_id,template_id,scanner_id,actor_type,actor_id,actor_key,
        idempotency_key,request_hash,method,state,outcome,action_id,action_kind,pass_version,at)
      SELECT ?,org_id,mode,pass_id,template_id,scanner_id,actor_type,actor_id,actor_key,?,request_hash,
        method,'done','ok',action_id,'check_in',pass_version,at+1
      FROM scans WHERE id=?`,
      [prefix, prefix, s.scanId],
    );
    const value = (await read.finalize())?.value;
    expect(value).toMatchObject({ scans: { total: 2 } });
    expect(value).not.toHaveProperty('visits');
    expect(listed(value)).toBe(1);
    // The new scan has no signed event: the next read counts it and lists only the proven one.
    const next = (await (await s.read()).finalize())?.value;
    expect(next).toMatchObject({ scans: { total: 2 } });
    expect(listed(next)).toBe(1);
  });

  it('does not list a scan whose action the template no longer has', async () => {
    const s = await checkedIn();
    await run(kit.env.DB, "UPDATE scans SET action_id='gone' WHERE pass_id=?", [s.pass.id]);
    const value = (await (await s.read()).finalize())?.value;
    expect(listed(value)).toBe(0);
  });
});

describe('display history of another pass', () => {
  it('never lists a scan of a different pass of the same template', async () => {
    const s = await checkedIn();
    const other = await kit.scanPass(s.templateId);
    const scanner = await kit.scanner({ templateIds: [s.templateId] });
    await kit.post(scanner.headers, '/actions', { ...requestOf(other.id), actionId: 'auto' });
    const history = await (await s.read()).finalize();
    expect(history?.value).toMatchObject({ scans: { total: 1 }, visits: { total: 1 } });
    expect(CHECK_IN.id).toBe('check_in');
  });
});

type Move =
  | 'listed scan undone'
  | 'pass deleted'
  | 'pass quarantined'
  | 'lifecycle moved'
  | 'credential rotated'
  | 'scanner revoked';

describe('display history when the world moves around the read', () => {
  const apply = async (move: Move, s: Awaited<ReturnType<typeof checkedIn>>) => {
    if (move === 'listed scan undone')
      await run(kit.env.DB, 'UPDATE scans SET undone_by=id WHERE id=?', [s.scanId]);
    else if (move === 'pass deleted')
      await run(kit.env.DB, 'UPDATE passes SET deleted_at=? WHERE id=?', [
        kit.clock.now(),
        s.pass.id,
      ]);
    else if (move === 'pass quarantined')
      await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined=1 WHERE id=?', [s.pass.id]);
    else if (move === 'lifecycle moved')
      await run(
        kit.env.DB,
        'UPDATE passes SET lifecycle_generation=lifecycle_generation+1 WHERE id=?',
        [s.pass.id],
      );
    else if (move === 'credential rotated')
      await startScanCredentialTransfer(kit, s.pass.id, {
        target: { holderEmail: `rotated-${key()}@example.test`, ownerUserId: null },
      });
    else
      await run(kit.env.DB, 'UPDATE scanners SET revoked_at=? WHERE id=?', [
        kit.clock.now(),
        s.scanner.id,
      ]);
  };

  it.each([
    'listed scan undone',
    'pass deleted',
    'pass quarantined',
    'lifecycle moved',
    'credential rotated',
    'scanner revoked',
  ] as const)(
    'lists nothing and claims no visits after %s, before or after the read',
    async (move) => {
      for (const when of ['before', 'after'] as const) {
        const s = await checkedIn();
        // Positive control: the same scan is listed until the world moves.
        expect(listed((await (await s.read()).finalize())?.value)).toBe(1);
        const read = await s.read(when === 'before' ? () => apply(move, s) : undefined);
        if (when === 'after') await apply(move, s);
        const value = (await read.finalize())?.value;
        expect(listed(value)).toBe(0);
        // No visit is claimed: none at all, or an empty history that counts none (the undone scan).
        expect((value as { visits?: { total: number } } | undefined)?.visits?.total ?? 0).toBe(0);
        // A moved pass is not the viewer's any more: not even its counts are shown.
        if (move !== 'listed scan undone' && move !== 'scanner revoked')
          expect(value ?? {}).not.toHaveProperty('scans');
      }
    },
  );
});
