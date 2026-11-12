import { beforeAll, describe, expect, it } from 'vitest';
import { stagePendingCredentialTransfer } from '../../../../test/helpers/credential-transfer.ts';
import { first, run, stmt } from '../../platform/db.ts';
import { toHex } from '../../platform/ids.ts';
import { historyPolicy } from './history-policy.ts';
import { historyProofPolicySources, historyProofSnapshots } from './history-proof.ts';
import {
  captureHistoryProofSnapshot,
  historyProofSnapshotPredicates,
} from './repo-history-proof-cas.ts';
import { candidateById } from './repo-lookup.ts';
import { policyRevisionHelpers } from './repo-policy-revision-test-fixtures.ts';
import { scanSecretSlots } from './repo-secret-binds.ts';
import { verifyScanEventProvenance } from './scan-event-proof.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
const { scenario, requestOf } = policyRevisionHelpers(() => kit);
beforeAll(async () => {
  kit = await setupScanKit();
});

describe('scanner history event and source proofs', () => {
  it('segments multibyte private evidence and binds every fragment to the captured keyset', async () => {
    const s = await scenario();
    const response = await kit.post(s.scanner.headers, '/actions', {
      ...requestOf(s.pass.id),
      actionId: 'auto',
    });
    const result = (await response.json()) as { kind: string; scanId: string | null };
    expect(result.kind).toBe('ok');
    if (!result.scanId) throw new Error('Missing scan');
    const large = '\u{1f600}'.repeat(200_000);
    await run(
      kit.env.DB,
      `UPDATE pass_versions
      SET pass_json=json_set(pass_json,'$.userInfo.large',?)
      WHERE pass_id=? AND version=?`,
      [large, s.pass.id, s.pass.version],
    );
    const proof = (await historyProofSnapshots(kit.ctx, s.actor, [result.scanId], new Map())).get(
      result.scanId,
    );
    if (!proof) throw new Error('Missing signed history proof');
    const now = kit.clock.now();
    const fragments = historyProofSnapshotPredicates(proof, 's', now);
    expect(fragments.length).toBeGreaterThan(1);
    const walletParts = fragments.flatMap((fragment) => {
      expect(fragment.params.slice(-2)).toEqual([now, proof.credentialKeysetCommitment]);
      const slots = scanSecretSlots(fragment.sql, fragment.params.length);
      if (!slots) throw new Error('Missing structural bind labels');
      return slots.flatMap((slot, index) =>
        slot.label === 'history-current-wallet-private-values' ? [fragment.params[index]] : [],
      );
    });
    expect(walletParts.length).toBeGreaterThan(1);
    expect(
      walletParts.every(
        (part) => typeof part === 'string' && new TextEncoder().encode(part).byteLength <= 750_000,
      ),
    ).toBe(true);
    expect(walletParts.join('')).toContain(toHex(new TextEncoder().encode(large)).toUpperCase());
    expect(JSON.stringify(proof)).not.toContain(large);
    const privateFields = Object.fromEntries(
      [
        'id',
        'ledger_id',
        'pass_id',
        'template_id',
        'scanner_id',
        'event_id',
        'actor_key',
        'staff_id',
        'request_hash',
        'reason',
        'action_id',
        'override_of',
        'approved_by',
        'undone_by',
        'presence_scope',
        'amount',
        'before_value',
        'after_value',
        'ledger_pass_id',
        'ledger_device',
        'ledger_actor_id',
        'ledger_data',
        'recorded_wallet_template_version',
        'recorded_personalization',
        'recorded_template_version',
        'event_pinned_manifest',
        'event_wallet_manifest',
        'event_active_version',
        'event_active_manifest',
        'current_personalization',
        'current_title',
        'current_scanner_name',
        'current_pinned_version',
        'current_pinned_manifest',
        'current_active_version',
        'current_active_manifest',
        'current_identity_id',
        'current_connection_id',
        'pass_serial',
        'pass_auth_token',
        'pass_download_token',
        'pass_web_service_url',
        'pass_scan_code',
        'pass_external_id',
        'pass_holder_email',
        'current_wallet_private_values',
      ].map((name) => [name, null]),
    );
    const oversized = captureHistoryProofSnapshot(
      {
        ...JSON.parse(proof.snapshot.metadata),
        ...privateFields,
        method: large,
      },
      proof.credentialKeysetCommitment,
    );
    if (!oversized) throw new Error('Missing synthetic metadata snapshot');
    const metadataFragments = historyProofSnapshotPredicates(
      { ...proof, snapshot: oversized },
      's',
      now,
    );
    expect(metadataFragments).toHaveLength(1);
    const metadataParams = metadataFragments[0]!.params;
    expect(metadataParams.slice(-2)).toEqual([now, proof.credentialKeysetCommitment]);
    const metadataParts = metadataParams.slice(0, -2);
    expect(metadataParts.length).toBeGreaterThan(1);
    expect(
      metadataParts.every(
        (part) => typeof part === 'string' && new TextEncoder().encode(part).byteLength <= 750_000,
      ),
    ).toBe(true);
    expect(JSON.parse(metadataParts.join(''))).toEqual([JSON.parse(oversized.metadata)]);
    const evaluate = (checks: typeof fragments) =>
      kit.env.DB.batch(
        checks.map((fragment) =>
          stmt(
            kit.env.DB,
            `SELECT 1 FROM scans s WHERE s.id=?/* scan-ephemeral-scan-id */ AND (${fragment.sql})`,
            [result.scanId!, ...fragment.params],
          ),
        ),
      );
    expect((await evaluate(fragments)).every((row) => row.results?.length === 1)).toBe(true);
    const otherKeyset =
      proof.credentialKeysetCommitment === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
    const wrongKeyset = historyProofSnapshotPredicates(
      { ...proof, credentialKeysetCommitment: otherKeyset },
      's',
      now,
    );
    expect(wrongKeyset).toEqual([{ sql: '0', params: [] }]);
    expect((await evaluate(wrongKeyset)).every((row) => (row.results?.length ?? 0) === 0)).toBe(
      true,
    );
    expect(
      historyProofSnapshotPredicates({ ...proof, credentialKeysetCommitment: 'invalid' }, 's', now),
    ).toEqual([{ sql: '0', params: [] }]);
    expect(
      historyProofSnapshotPredicates({ ...proof, snapshot: { ...proof.snapshot } }, 's', now),
    ).toEqual([{ sql: '0', params: [] }]);
  });

  it.each(['[]', 'null'])(
    'accepts a %s historical Wallet source without falling back',
    async (stored) => {
      const s = await scenario();
      const candidate = await candidateById(kit.env.DB, kit.org.id, s.pass.id);
      if (!candidate?.walletVersion) throw new Error('Missing Wallet row');
      await run(
        kit.env.DB,
        'UPDATE pass_versions SET personalization=? WHERE pass_id=? AND version=?',
        [stored, s.pass.id, candidate.walletVersion],
      );
      const response = await kit.post(s.scanner.headers, '/actions', {
        ...requestOf(s.pass.id),
        actionId: 'auto',
      });
      const result = (await response.json()) as { kind: string; scanId: string | null };
      expect(result).toMatchObject({ kind: 'ok', scanId: expect.any(String) });
      if (!result.scanId) throw new Error('Missing scan');
      const ledger = await first<{ data: string }>(
        kit.env.DB,
        "SELECT data FROM pass_events WHERE pass_id=? AND kind='scan.checked_in'",
        [s.pass.id],
      );
      const data = JSON.parse(ledger!.data);
      expect(data.authority.personalizationHash).toEqual(expect.any(String));
      expect(data.authority.evaluatedPersonalizationHash).toEqual(expect.any(String));
      expect(ledger!.data).not.toContain('Revision Private Person');
      expect(ledger!.data).not.toContain('Check in');
      if (s.actor.scanner?.name) expect(ledger!.data).not.toContain(s.actor.scanner.name);
      const proofs = await historyProofSnapshots(kit.ctx, s.actor, [result.scanId], new Map());
      const proof = proofs.get(result.scanId);
      if (!proof) throw new Error('Missing signed history proof');
      const sources = historyProofPolicySources(proof);
      if (!sources) throw new Error('Missing history policy sources');
      expect(sources.versionPersonalization).toBe(stored);
      const policy = await historyPolicy(kit.env, { ...sources, role: s.actor.role });
      expect(policy?.action('check_in', 'check_in')?.label).toBe('Check in');
      expect(
        JSON.stringify(await (await kit.get(s.scanner.headers, '/scans?limit=5')).json()),
      ).not.toContain('evaluatedPersonalizationHash');
    },
  );

  it('freezes event, scan and manifest inputs before asynchronous history verification', async () => {
    const s = await scenario();
    const result = (await (
      await kit.post(s.scanner.headers, '/actions', {
        ...requestOf(s.pass.id),
        actionId: 'auto',
      })
    ).json()) as { kind: string; scanId: string | null };
    expect(result.kind).toBe('ok');
    if (!result.scanId) throw new Error('Missing scan');
    const proof = (await historyProofSnapshots(kit.ctx, s.actor, [result.scanId], new Map())).get(
      result.scanId,
    );
    if (!proof) throw new Error('Missing policy proof');
    const sources = historyProofPolicySources(proof);
    const action = sources?.currentPinned?.manifest.scan?.actions[0];
    if (!sources || !action) throw new Error('Missing policy sources');
    const proofCache = new Map<string, Promise<boolean>>();
    expect(await verifyScanEventProvenance(kit.env, sources.event, sources.scan, proofCache)).toBe(
      true,
    );
    const cacheKey = [...proofCache.keys()][0];
    if (!cacheKey) throw new Error('Missing proof cache key');
    expect(proofCache.size).toBe(1);
    // Keyed by a hash of the exact event and scan row; no keyset commitment takes part.
    expect(cacheKey).toMatch(/^[0-9a-f]{64}$/);
    const DeferredPromise = Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
    };
    const deferred = DeferredPromise.withResolvers<boolean>();
    proofCache.set(cacheKey, deferred.promise);
    const pending = historyPolicy(kit.env, { ...sources, role: s.actor.role, proofCache });
    // Inputs are frozen or copied: a write after the call, refused or not, cannot reach the verdict.
    expect(Object.isFrozen(sources.event)).toBe(true);
    const mutate = (write: () => void) => {
      try {
        write();
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
      }
    };
    mutate(() => {
      sources.event.data = '{}';
    });
    mutate(() => {
      sources.scan.actionId = 'changed';
    });
    mutate(() => {
      action.label = 'Changed';
    });
    deferred.resolve(true);
    const policy = await pending;
    expect(policy?.action('check_in', 'check_in')?.label).toBe('Check in');
  });

  it('proves a custom action without persisting its identifier or label in the event', async () => {
    const actionId = 'entry_gate_73';
    const label = 'Enter venue';
    const templateId = await kit.scanTemplate('Private action reference', {
      actions: [{ id: actionId, label, kind: 'check_in' }],
    });
    const pass = await kit.scanPass(templateId);
    const scanner = await kit.scanner({ templateIds: [templateId], settings: { lookup: true } });
    const result = (await (
      await kit.post(scanner.headers, '/actions', {
        ...requestOf(pass.id),
        actionId,
      })
    ).json()) as { kind: string; scanId: string | null };
    expect(result).toMatchObject({ kind: 'ok', scanId: expect.any(String) });
    const ledger = await first<{ data: string }>(
      kit.env.DB,
      "SELECT data FROM pass_events WHERE pass_id=? AND kind='scan.checked_in'",
      [pass.id],
    );
    expect(ledger?.data).not.toContain(actionId);
    expect(ledger?.data).not.toContain(label);
    const recent = (await (await kit.get(scanner.headers, '/scans?limit=5')).json()) as {
      items: { scanId: string; actionLabel: string }[];
    };
    expect(recent.items.find((item) => item.scanId === result.scanId)).toMatchObject({
      actionLabel: label,
    });
  });

  it.each([
    'pass personalization',
    'Wallet personalization',
    'signed event',
    'scan scope',
    'private value',
    'credential generation',
    'lifecycle generation',
  ] as const)(
    'invalidates the final history CAS when %s changes after verification',
    async (changed) => {
      const s = await scenario();
      const result = (await (
        await kit.post(s.scanner.headers, '/actions', {
          ...requestOf(s.pass.id),
          actionId: 'auto',
        })
      ).json()) as { kind: string; scanId: string | null };
      expect(result.kind).toBe('ok');
      if (!result.scanId) throw new Error('Missing scan');
      const proofs = await historyProofSnapshots(kit.ctx, s.actor, [result.scanId], new Map());
      const proof = proofs.get(result.scanId);
      if (!proof) throw new Error('Missing signed history proof');
      const sources = historyProofPolicySources(proof);
      if (!sources) throw new Error('Missing history policy sources');
      const predicates = historyProofSnapshotPredicates(proof, 's', kit.clock.now());
      expect(predicates.length).toBeGreaterThan(0);
      expect(predicates.every((predicate) => predicate.sql !== '0')).toBe(true);
      const current = async () => {
        const results = await kit.env.DB.batch(
          predicates.map((predicate) =>
            stmt(
              kit.env.DB,
              `SELECT 1 FROM scans s WHERE s.id=?/* scan-ephemeral-scan-id */ AND (${predicate.sql})`,
              [result.scanId!, ...predicate.params],
            ),
          ),
        );
        return (
          results.length === predicates.length && results.every((row) => row.results?.length === 1)
        );
      };
      expect(await current()).toBe(true);
      if (changed === 'pass personalization') {
        await run(
          kit.env.DB,
          "UPDATE passes SET personalization=json_set(personalization,'$.memberName','Changed') WHERE id=?",
          [s.pass.id],
        );
      } else if (changed === 'Wallet personalization') {
        await run(
          kit.env.DB,
          "UPDATE pass_versions SET personalization=json_set(personalization,'$.memberName','Changed') WHERE pass_id=? AND version=?",
          [s.pass.id, sources.scan.walletVersion],
        );
      } else if (changed === 'signed event') {
        await run(
          kit.env.DB,
          "UPDATE pass_events SET data=json_set(data,'$.authority.role','manager') WHERE id=?",
          [sources.event.id],
        );
      } else if (changed === 'scan scope') {
        await run(kit.env.DB, "UPDATE scans SET presence_scope='event:altered' WHERE id=?", [
          result.scanId,
        ]);
      } else if (changed === 'private value') {
        await run(kit.env.DB, "UPDATE passes SET external_id='Private proof value' WHERE id=?", [
          s.pass.id,
        ]);
      } else if (changed === 'credential generation') {
        const before = await first<{ credential_generation: number }>(
          kit.env.DB,
          'SELECT credential_generation FROM passes WHERE id=?',
          [s.pass.id],
        );
        if (!before) throw new Error('Missing pass generation.');
        await stagePendingCredentialTransfer(kit.env.DB, s.pass.id, {
          id: kit.fx.ids.id(),
          token: kit.fx.ids.token(),
          now: kit.clock.now(),
          targetHolderEmail: 'next-holder@example.test',
        });
        expect(
          await first(kit.env.DB, 'SELECT credential_generation FROM passes WHERE id=?', [
            s.pass.id,
          ]),
        ).toEqual({ credential_generation: before.credential_generation + 1 });
      } else {
        await run(
          kit.env.DB,
          'UPDATE passes SET lifecycle_generation=lifecycle_generation+1 WHERE id=?',
          [s.pass.id],
        );
      }
      expect(await current()).toBe(false);
      if (changed === 'lifecycle generation') {
        const refreshed = (
          await historyProofSnapshots(kit.ctx, s.actor, [result.scanId], new Map())
        ).get(result.scanId);
        expect(refreshed?.projectionCurrent).toBe(true);
        if (!refreshed) throw new Error('Missing refreshed history proof');
        const refreshedSources = historyProofPolicySources(refreshed);
        if (!refreshedSources) throw new Error('Missing refreshed policy sources');
        const policy = await historyPolicy(kit.env, { ...refreshedSources, role: s.actor.role });
        expect(policy?.action('check_in', 'check_in')?.label).toBe('Check in');
      }
    },
  );
});
