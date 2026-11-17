import { describe, expect, it, vi } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import type { ScanManifest } from '../../../passkit/types.ts';
import { all, first, run } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import {
  credentialRefKeysetCommitment,
  ensureCredentialRefKeyset,
} from '../passes/credential-keyset.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { recordedCheckIn, recordedNoMatch } from './console-privacy-actions-test-fixtures.ts';
import {
  insertVersion,
  kit,
  PUBLIC,
  setupPrivacyKit,
  templateId,
} from './console-privacy-test-fixtures.ts';
import { type HistoryRaw, policyCandidateOf, projectionCurrentOf } from './history-row.ts';
import { scanLedgerScopeSql } from './repo-feed-scope.ts';
import { type HistoryProofRow, historyProofRowsStmt } from './repo-history-proof-read.ts';
import { policyCandidateSql as oldPolicyCandidateSql } from './repo-history-row-shadow-test-fixtures.ts';
import { testFence } from './repo-history-row-test-support.ts';
import { readHistoryPage } from './repo-history-rows.ts';
import { startScanCredentialTransfer } from './test-kit.ts';

setupPrivacyKit();

/*
 * The drift gate for the history row flags. The old builders (`policyCandidateSql` of the feed and
 * the history proof read's `projection_current`) answer from separate statements; the page
 * statement splits them into column flags over joined aliases and combines them in JS. Each state
 * below is read both ways, row by row, and the answers must be identical. Each case also names the
 * answer it expects, so a bug the old and the new share cannot pass, and whether it must still be in
 * the ledger scope, so a case that silently drops out of both reads cannot pass either.
 */

async function newRows() {
  const { authorized, rows } = await readHistoryPage(
    kit.env.DB,
    testFence(kit.org.id),
    { where: scanLedgerScopeSql('s'), params: [], limit: 500 },
    kit.clock.now(),
  );
  expect(authorized).toBe(true);
  return new Map(rows.map((row) => [row.id, row.raw]));
}

async function oldFlags(ids: readonly string[]) {
  const now = kit.clock.now();
  const candidates = await all<{ id: string; pc: number }>(
    kit.env.DB,
    `SELECT s.id, ${oldPolicyCandidateSql('s')} AS pc FROM scans s
     WHERE s.id IN (${ids.map(() => '?').join(',')})`,
    [now, ...ids],
  );
  await ensureCredentialRefKeyset(kit.env.DB, kit.env);
  const commitment = await credentialRefKeysetCommitment(kit.env);
  const proofs = (
    await historyProofRowsStmt(
      kit.ctx,
      { ids },
      's.org_id=? AND s.mode=?',
      [kit.org.id, 'live'],
      commitment,
    ).all<HistoryProofRow>()
  ).results;
  return {
    policy: new Map(candidates.map((row) => [row.id, row.pc === 1])),
    proof: new Map(proofs.map((row) => [row.id, row])),
  };
}

interface Want {
  /** Still on the history page (and in the old proof read) after the mutation. */
  inScope: boolean;
  policy: boolean;
  projection: boolean;
}

interface Case {
  name: string;
  scanId: string;
  want: Want;
  /** After the template is deleted. */
  deleted?: Want;
  /** The old proof read judged the pinned template by the event's text even when no such version exists. */
  proofFlagsMayDiffer?: boolean;
}

type Phase = 'start' | 'templateDeleted' | 'orgSuspended';

const wantIn = (c: Case, phase: Phase): Want => {
  const w = phase === 'start' ? c.want : (c.deleted ?? c.want);
  return phase === 'orgSuspended' ? { ...w, projection: false } : w;
};

/** Compare every case under the current database state against the old builders and its expectation. */
async function compare(cases: readonly Case[], phase: Phase) {
  const fresh = await newRows();
  const old = await oldFlags(cases.map((c) => c.scanId));
  for (const c of cases) {
    const want = wantIn(c, phase);
    const raw: HistoryRaw | undefined = fresh.get(c.scanId);
    const proof = old.proof.get(c.scanId);
    expect(raw !== undefined, `${c.name}: on the page`).toBe(want.inScope);
    expect(proof !== undefined, `${c.name}: in the old proof read`).toBe(want.inScope);
    if (!raw || !proof) continue;
    expect(policyCandidateOf(raw), `${c.name}: policy candidate`).toBe(old.policy.get(c.scanId));
    expect(policyCandidateOf(raw), `${c.name}: expected policy candidate`).toBe(want.policy);
    expect(projectionCurrentOf(raw), `${c.name}: projection current`).toBe(
      proof.projection_current === 1,
    );
    expect(projectionCurrentOf(raw), `${c.name}: expected projection`).toBe(want.projection);
    if (c.proofFlagsMayDiffer) {
      // A flag may only be stricter than the old one, and never set without the old one.
      expect(raw.approved_proof <= proof.approved_proof, `${c.name}: approved proof`).toBe(true);
      expect(raw.legacy_proof <= proof.legacy_proof, `${c.name}: legacy proof`).toBe(true);
    } else {
      expect(raw.approved_proof, `${c.name}: approved proof`).toBe(proof.approved_proof);
      expect(raw.legacy_proof, `${c.name}: legacy proof`).toBe(proof.legacy_proof);
    }
  }
}

const GOOD: Want = { inScope: true, policy: true, projection: true };
const NO_POLICY: Want = { inScope: true, policy: false, projection: true };
const NONE: Want = { inScope: true, policy: false, projection: false };
const GONE: Want = { inScope: false, policy: false, projection: false };

describe('history row flags against the old builders', () => {
  it('answer alike, and as expected, over a varied fixture set', async () => {
    const db = kit.env.DB;
    const at = kit.clock.now();
    const scanners = new Map<string, Awaited<ReturnType<typeof kit.scanner>>>();
    const scannerFor = async (template: string) => {
      const found = scanners.get(template);
      if (found) return found;
      const created = await kit.scanner({ templateIds: [template] });
      scanners.set(template, created);
      return created;
    };
    const cases: Case[] = [];
    /** A pass and its signed check-in on `template`; `setup` mutates the state, then the case is recorded. */
    const given = async (
      name: string,
      want: Want,
      setup: (ids: { passId: string; scanId: string }) => Promise<unknown> | undefined = () =>
        undefined,
      options: { template?: string; deleted?: Want; proofFlagsMayDiffer?: boolean } = {},
    ) => {
      const template = options.template ?? templateId;
      const created = await kit.scanPass(template, { memberName: `${PUBLIC} ${name}` });
      const scan = await recordedCheckIn(await scannerFor(template), created.id);
      await setup({ passId: created.id, scanId: scan.id });
      cases.push({
        name,
        scanId: scan.id,
        want,
        ...(options.deleted ? { deleted: options.deleted } : {}),
        ...(options.proofFlagsMayDiffer ? { proofFlagsMayDiffer: true } : {}),
      });
    };
    const setPass =
      (sql: string, ...extra: (string | number)[]) =>
      ({ passId }: { passId: string }) =>
        run(db, `UPDATE passes SET ${sql} WHERE id = ?`, [...extra, passId]);
    const setEvents =
      (sql: string, ...extra: (string | number)[]) =>
      ({ passId }: { passId: string }) =>
        run(db, `UPDATE pass_events SET ${sql} WHERE pass_id = ?`, [...extra, passId]);
    const setWallet =
      (sql: string, ...extra: (string | number)[]) =>
      ({ passId }: { passId: string }) =>
        run(db, `UPDATE pass_versions SET ${sql} WHERE pass_id = ?`, [...extra, passId]);

    await given('baseline', GOOD);
    await given('voided pass', NONE, setPass("status = 'voided'"));
    await given('removed pass', NONE, setPass('removed_at = ?', at));
    await given('removed then restored pass', GOOD, async ({ passId }) => {
      await run(db, 'UPDATE passes SET removed_at = ? WHERE id = ?', [at, passId]);
      await run(db, 'UPDATE passes SET removed_at = NULL WHERE id = ?', [passId]);
    });
    await given('deleted pass', NONE, setPass('deleted_at = ?', at));
    await given('quarantined pass', GONE, setPass('test_data_quarantined = 1'));
    await given('personalization not an object', NO_POLICY, setPass("personalization = '[]'"));
    await given('field sources not an object', NO_POLICY, setPass("field_sources = '[]'"));
    await given(
      'expired wallet',
      NONE,
      setWallet("pass_json = json_set(pass_json, '$.expirationDate', '2000-01-01T00:00:00Z')"),
    );
    await given(
      'voided wallet',
      NONE,
      setWallet("pass_json = json_set(pass_json, '$.voided', json('true'))"),
    );
    await given(
      'wallet serial mismatch',
      NONE,
      setWallet("pass_json = json_set(pass_json, '$.serialNumber', 'another-serial')"),
    );
    await given('legacy release', GOOD, setPass('release_id = NULL'));
    // A release of the Test mode is not issued in Live: the pass is no longer ledger-visible.
    await given('release not issued', GONE, async ({ passId }) => {
      const wrongMode = await first<{ id: string }>(
        db,
        "SELECT id FROM template_releases WHERE template_id = ? AND mode = 'test' LIMIT 1",
        [templateId],
      );
      if (!wrongMode) throw new Error('The Test-mode release must exist.');
      await run(db, 'UPDATE passes SET release_id = ? WHERE id = ?', [wrongMode.id, passId]);
    });
    await given(
      'release class tampered',
      NO_POLICY,
      setEvents("data = json_set(data, '$.authority.releaseClass', 'legacy')"),
    );
    await given(
      'lineage tampered',
      NONE,
      setEvents("data = json_set(data, '$.authority.credentialGeneration', 7)"),
    );
    await given(
      'wallet version tampered',
      NO_POLICY,
      setEvents("data = json_set(data, '$.authority.walletVersion', 99)"),
    );
    await given(
      'wallet version as text',
      NO_POLICY,
      setEvents("data = json_set(data, '$.authority.walletVersion', '1')"),
    );
    await given(
      'event authority not an object',
      NONE,
      setEvents("data = json_set(data, '$.authority', 'x')"),
    );
    await given(
      'pinned template version missing',
      NO_POLICY,
      setEvents("data = json_set(data, '$.authority.pinnedTemplateVersion', 'no-such-version')"),
      { proofFlagsMayDiffer: true },
    );
    await given('two ledger events for one scan', NONE, async ({ scanId }) => {
      await run(
        db,
        `INSERT INTO pass_events (id, org_id, pass_id, mode, kind, device, actor_type, actor_id, data, at)
         SELECT id || '-twin', org_id, pass_id, mode, kind, device, actor_type, actor_id, data, at
         FROM pass_events WHERE json_extract(data, '$.scanId') = ?`,
        [scanId],
      );
    });
    await given('ledger event in another mode', NONE, setEvents("mode = 'test'"));
    await given('ledger event in another org', NONE, async ({ passId }) => {
      const other = await makeOrg(kit.fx);
      await run(db, 'UPDATE pass_events SET org_id = ? WHERE pass_id = ?', [other.id, passId]);
    });
    await given('pending credential transfer', NONE, async ({ passId }) => {
      const put = vi
        .spyOn(kit.env.BUCKET, 'put')
        .mockRejectedValueOnce(new Error('Publication unavailable'));
      try {
        expect(await startScanCredentialTransfer(kit, passId)).toMatchObject({ state: 'pending' });
      } finally {
        put.mockRestore();
      }
    });
    await given('credential generation bumped', NONE, async ({ passId }) => {
      expect(await startScanCredentialTransfer(kit, passId)).toMatchObject({ state: 'completed' });
    });
    const connect =
      (id: string, enabled: number, orgId: string) =>
      async ({ passId }: { passId: string }) => {
        await run(
          db,
          `INSERT INTO connections (id, org_id, connector_type, name, enabled, generation, created_at, updated_at)
         VALUES (?, ?, 'test', ?, ?, 1, ?, ?)`,
          [id, orgId, id, enabled, at, at],
        );
        await run(db, 'UPDATE passes SET connection_id = ? WHERE id = ?', [id, passId]);
      };
    await given('enabled connection', GOOD, connect('conn-on', 1, kit.org.id));
    await given('disabled connection', NONE, connect('conn-off', 0, kit.org.id));
    await given('connection of another org', GONE, async (ids) => {
      const other = await makeOrg(kit.fx);
      await connect('conn-foreign', 1, other.id)(ids);
    });

    const noMatch = await recordedNoMatch(await scannerFor(templateId));
    cases.push({
      name: 'passless refusal',
      scanId: noMatch.id,
      want: { inScope: true, policy: true, projection: false },
    });

    // A second template: one pass on it moves to another template, one keeps a template whose
    // head is a build the pass cannot be used under, one is deleted below.
    const spec: ScanManifest = {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'always' }],
    };
    const swap = await kit.scanTemplate('Swapped template', spec);
    await given('pass on another template', GONE, async ({ passId }) => {
      const resolved = await kit.registry.resolve(swap);
      await run(
        db,
        'UPDATE passes SET template_id = ?, template_version = ?, release_id = NULL WHERE id = ?',
        [swap, resolved.version, passId],
      );
    });

    const build = await kit.scanTemplate('Rebuilt template', spec);
    await given('incompatible release build', NO_POLICY, undefined, { template: build });
    const v1 = await kit.registry.resolve(build, 'v1');
    const v2 = kit.registry.add({
      id: build,
      orgId: kit.org.id,
      version: 'v2',
      manifest: structuredClone(v1.manifest),
      passJson: v1.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    await insertVersion(v2, 'a-build-the-pinned-version-is-not-compatible-with');
    await approveAppleRelease(kit, {
      orgId: kit.org.id,
      mode: 'live',
      templateId: build,
      version: v2.version,
    });

    const doomed = await kit.scanTemplate('Shadow template', spec);
    await given('deleted template', GOOD, undefined, { template: doomed, deleted: NONE });

    await compare(cases, 'start');
    // The fixtures vary: an agreement over one answer proves nothing.
    expect(new Set(cases.map((c) => c.want.policy)).size).toBe(2);
    expect(new Set(cases.map((c) => c.want.projection)).size).toBe(2);

    await run(db, "UPDATE templates SET status = 'deleted' WHERE id = ?", [doomed]);
    await compare(cases, 'templateDeleted');

    await run(db, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [kit.org.id]);
    await compare(cases, 'orgSuspended');
  });
});
