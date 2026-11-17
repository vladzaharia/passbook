import { beforeAll, describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import type { ScanActor } from './actor.ts';
import { historyPolicy } from './history-policy.ts';
import { createHistoryEvidenceCache, historyEvidenceOf } from './history-row-evidence.ts';
import { readHistoryPage } from './repo-history-rows.ts';
import { candidateById } from './repo-lookup.ts';
import { policyRevisionHelpers } from './repo-policy-revision-test-fixtures.ts';
import { scanReadAuthority } from './repo-read-authority.ts';
import { HISTORY_READ } from './repo-scan-history.ts';
import { verifyScanEventProvenance } from './scan-event-proof.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
const { scenario, requestOf } = policyRevisionHelpers(() => kit);
beforeAll(async () => {
  kit = await setupScanKit();
});

/** The policy sources a console-style history read gives one scan: one snapshot, no re-proof. */
async function sourcesOf(actor: ScanActor, scanId: string) {
  const now = kit.clock.now();
  const page = await readHistoryPage(
    kit.env.DB,
    scanReadAuthority(actor, { now, read: HISTORY_READ }),
    { where: 's.id = ?', params: [scanId], limit: 1 },
    now,
  );
  const evidence = await historyEvidenceOf(kit.ctx, page.rows, {
    role: actor.role,
    cache: createHistoryEvidenceCache(),
    requireAvailable: false,
  });
  const found = evidence.get(scanId);
  if (!found) throw new Error('Missing history policy sources');
  return found.sources;
}

describe('scanner history event and source proofs', () => {
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
      const sources = await sourcesOf(s.actor, result.scanId);
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
    const sources = await sourcesOf(s.actor, result.scanId);
    const action = sources.currentPinned?.manifest.scan?.actions[0];
    if (!action) throw new Error('Missing policy sources');
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
    // Inputs are copied at the call: a write after it cannot reach the verdict.
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
});
