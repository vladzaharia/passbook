import { runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ScanLiveRow } from '../../../shared/contracts/scan-setups.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { act } from './act.ts';
import { scannerActor, withRole } from './actor.ts';
import { credentialTombstoneRefsForInput } from './credential-input.ts';
import { liveAttachment, publishScan, scanHub } from './live.ts';
import {
  type InternalLiveRow,
  livePassSnapshot,
  openLiveSourceProof,
  sealLiveSourceProof,
} from './live-provenance.ts';
import { registerProvenanceRouteTests } from './live-provenance-route-test-fixtures.ts';
import { getScanner } from './repo-device.ts';
import { readScannerScope } from './repo-scope.ts';
import { setSetupWatchStmt } from './repo-setups-test-support.ts';
import { copyScanEpochs } from './scan-epochs.ts';
import { bindScanningSession } from './scanning-workspace.ts';
import { codeOf, key, proofedScanActor, type ScanKit, setupScanKit } from './test-kit.ts';

describe('live provenance transport', () => {
  let kit: ScanKit;
  let template: string;
  beforeAll(async () => {
    kit = await setupScanKit();
    await ensureCredentialRefKeyset(kit.env.DB, kit.env);
    template = await kit.scanTemplate('Provenance', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    await kit.scanner({ deviceRole: 'monitor' });
  });

  async function sourceActor() {
    const source = await kit.scanner({ templateIds: [template] });
    const device = await getScanner(kit.env.DB, source.id);
    if (!device) throw new Error('Missing scanner fixture.');
    return proofedScanActor(
      kit.ctx,
      withRole(
        scannerActor(kit.ctx, device, 'live', 'cookie', { event: null, templateIds: [template] }),
        null,
      ),
    );
  }

  registerProvenanceRouteTests(() => ({ kit, template }));

  it('rejects absent, conflicting or substituted input authority before publishing', async () => {
    const source = await sourceActor();
    delete source.credentialKeysetCommitment;
    const pass = await kit.scanPass(template);
    const evaluation = await act(kit.ctx, source, {
      input: codeOf(pass),
      actionId: 'check_in',
      clientTs: kit.clock.now(),
      idempotencyKey: key(),
    });
    const { outcome, evaluatedSnapshot, credentialContext } = evaluation;
    if (!evaluatedSnapshot || !credentialContext?.otherModeCredentialTombstoneRefs.length)
      throw new Error('Missing evaluated credential authority.');
    expect(source.credentialKeysetCommitment).toBeUndefined();
    const different =
      credentialContext.credentialKeysetCommitment === 'f'.repeat(64)
        ? 'e'.repeat(64)
        : 'f'.repeat(64);
    publishScan(kit.ctx, source, outcome, evaluatedSnapshot, null, 'camera');
    publishScan(
      kit.ctx,
      { ...source, credentialKeysetCommitment: different },
      outcome,
      evaluatedSnapshot,
      credentialContext,
      'camera',
    );
    publishScan(
      kit.ctx,
      source,
      outcome,
      evaluatedSnapshot,
      { ...credentialContext, otherModeCredentialTombstoneRefs: [] },
      'camera',
    );
    await kit.settle();
    const hub = scanHub(kit.ctx, kit.org.id, 'live');
    const rejected = await runInDurableObject(hub, async (_object, state) =>
      ((await state.storage.get<InternalLiveRow[]>('recent')) ?? []).filter(
        (entry) => entry.scannerId === source.scanner!.id,
      ),
    );
    expect(rejected).toEqual([]);
    publishScan(kit.ctx, source, outcome, evaluatedSnapshot, credentialContext, 'camera');
    await kit.settle();
    const rows = await runInDurableObject(hub, async (_object, state) =>
      ((await state.storage.get<InternalLiveRow[]>('recent')) ?? []).filter(
        (entry) => entry.scannerId === source.scanner!.id,
      ),
    );
    expect(rows).toHaveLength(1);
    const proof = await openLiveSourceProof(kit.env, rows[0]!.sourceProof);
    expect(proof?.actor.credentialKeysetCommitment).toBe(
      credentialContext.credentialKeysetCommitment,
    );
    expect(proof?.credentialContext).toEqual(credentialContext);
    expect(source.credentialKeysetCommitment).toBeUndefined();
  });

  it('captures the original actor synchronously before asynchronous pass resolution', async () => {
    const source = await sourceActor();
    const pass = await kit.scanPass(template);
    const { outcome, evaluatedSnapshot, credentialContext } = await act(kit.ctx, source, {
      input: codeOf(pass),
      actionId: 'auto',
      clientTs: kit.clock.now(),
      idempotencyKey: key(),
    });
    if (!evaluatedSnapshot || !credentialContext)
      throw new Error('Missing evaluated pass authority.');
    const passSnapshot = await livePassSnapshot(kit.env, evaluatedSnapshot);
    const original = structuredClone(source);
    copyScanEpochs(source, original);
    const originalContext = structuredClone(credentialContext);
    const mutableContext = structuredClone(credentialContext);
    const hub = scanHub(kit.ctx, kit.org.id, 'live');
    await runInDurableObject(hub, async (_object, state) => state.storage.delete('recent'));

    publishScan(kit.ctx, source, outcome, evaluatedSnapshot, mutableContext, 'camera');
    source.actorKey = 'changed-actor-key';
    source.templateIds.push('changed-template');
    source.scanner!.tokenHash = 'changed-token-hash';
    source.scanner!.csrfSecret = 'changed-csrf';
    mutableContext.credentialTombstoneRefs = ['f'.repeat(64)];
    mutableContext.otherModeCredentialTombstoneRefs = ['e'.repeat(64)];
    await kit.settle();

    const rows = await runInDurableObject(
      hub,
      async (_object, state) => (await state.storage.get<InternalLiveRow[]>('recent')) ?? [],
    );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).not.toBe(outcome.scanId);
    expect(row.passId).toBe(pass.id);
    expect(await hub.sourceProof(row.id)).toBe(row.sourceProof);
    expect(await openLiveSourceProof(kit.env, row.sourceProof)).toEqual({
      actor: original,
      eventId: row.id,
      credentialContext: originalContext,
      passId: pass.id,
      passSnapshot,
      at: row.at,
    });
    const stored = JSON.stringify(row);
    expect(stored).not.toContain(original.scanner!.tokenHash!);
    expect(stored).not.toContain('changed-csrf');
    expect(stored).not.toContain(original.scannerCsrfProof!);
    for (const ref of [
      ...originalContext.credentialTombstoneRefs,
      ...originalContext.otherModeCredentialTombstoneRefs,
    ])
      expect(stored).not.toContain(ref);
  });

  it('only returns sealed proofs for retained and unexpired rows', async () => {
    const source = await sourceActor();
    const hub = scanHub(kit.ctx, kit.org.id, 'live');
    const now = Date.now();
    const credentialContext = await credentialTombstoneRefsForInput(
      kit.ctx,
      source.orgId,
      source.mode,
      { passId: 'fixture', method: 'manual' },
    );
    const row = (id: string, at: number): ScanLiveRow => ({
      id,
      at,
      scannerId: source.scanner!.id,
      scannerName: source.name,
      passId: null,
      holder: null,
      photoUrl: null,
      kind: 'ok',
      direction: 'in',
      label: 'Checked in',
      presented: true,
    });
    const seal = async (id: string, at: number): Promise<InternalLiveRow> => ({
      ...row(id, at),
      sourceProof: await sealLiveSourceProof(kit.env, {
        actor: source,
        eventId: id,
        credentialContext,
        passId: null,
        passSnapshot: null,
        at,
      }),
    });
    const expired = await seal('expired', now - 15 * 60_000);
    const active = await seal('active', now - 1_000);
    const legacy = row('legacy', now - 1_000);
    await runInDurableObject(hub, async (_object, state) =>
      state.storage.put('recent', [expired, active, legacy]),
    );
    expect(await hub.sourceProof('expired')).toBeNull();
    expect(await hub.sourceProof('legacy')).toBeNull();
    expect(await hub.sourceProof('missing')).toBeNull();
    expect(await hub.sourceProof('active')).toBe(active.sourceProof);
    expect(await openLiveSourceProof(kit.env, active.sourceProof)).toEqual({
      actor: source,
      eventId: active.id,
      credentialContext,
      passId: null,
      passSnapshot: null,
      at: active.at,
    });

    const otherEvent = await seal('other-event', active.at);
    const altered =
      active.sourceProof.slice(0, 3) +
      (active.sourceProof[3] === 'A' ? 'B' : 'A') +
      active.sourceProof.slice(4);
    for (const invalid of [
      { ...active, sourceProof: otherEvent.sourceProof },
      { ...active, sourceProof: altered },
      { ...active, passId: 'another-pass' },
      { ...active, at: active.at + 1 },
      { ...active, scannerId: 'another-scanner' },
    ]) {
      await runInDurableObject(hub, async (_object, state) =>
        state.storage.put('recent', [invalid]),
      );
      expect(await hub.sourceProof(active.id)).toBeNull();
    }

    const retained = await Promise.all(
      Array.from({ length: 100 }, (_, index) => seal(`event-${index}`, now - 2_000 + index)),
    );
    await runInDurableObject(hub, async (_object, state) => state.storage.put('recent', retained));
    expect(await hub.sourceProof(retained[0]!.id)).toBe(retained[0]!.sourceProof);
    const newest = await seal('newest', Date.now());
    expect(await hub.publish({ orgId: kit.org.id, mode: 'live', row: newest })).toBe(true);
    expect(await hub.sourceProof(retained[0]!.id)).toBeNull();
    expect(await hub.sourceProof(retained[1]!.id)).toBe(retained[1]!.sourceProof);
    expect(await hub.sourceProof(newest.id)).toBe(newest.sourceProof);

    // Random ids do not order same-millisecond events; reconnecting after the first
    // must still find the second, even when its id sorts earlier.
    await runInDurableObject(hub, async (_object, state) => state.storage.delete('recent'));
    const monitor = await kit.scanner({ deviceRole: 'monitor' });
    await setSetupWatchStmt(kit.env.DB, kit.org.id, monitor.id, {
      scannerIds: [source.scanner!.id],
      allOrg: false,
    }).run();
    const monitorRow = await getScanner(kit.env.DB, monitor.id);
    if (!monitorRow?.tokenHash || !monitorRow.csrfSecret)
      throw new Error('Missing monitor fixture.');
    const scope = await readScannerScope(kit.env.DB, monitorRow, monitorRow.staffId);
    const monitorActor = scannerActor(kit.ctx, monitorRow, monitorRow.mode, 'cookie', scope);
    await bindScanningSession(kit.ctx, monitorActor);
    withRole(monitorActor, null);
    const attachment = liveAttachment(kit.ctx, await proofedScanActor(kit.ctx, monitorActor));
    const sameAt = Date.now();
    const first = await seal('z-first', sameAt);
    const second = await seal('a-second', sameAt);
    expect(await hub.publish({ orgId: kit.org.id, mode: 'live', row: first })).toBe(true);
    expect((await hub.snapshot(attachment)).cursor).toBe(first.id);
    expect(await hub.publish({ orgId: kit.org.id, mode: 'live', row: second })).toBe(true);
    const catchup = await hub.snapshot(attachment, first.id);
    expect(catchup.rows.map((entry) => entry.id)).toEqual([second.id]);
    expect(catchup.cursor).toBe(second.id);
  });
});
