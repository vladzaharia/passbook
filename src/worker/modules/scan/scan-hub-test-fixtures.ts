import { beforeAll, expect, vi } from 'vitest';
import type { ScanLiveRow } from '../../../shared/contracts/scan-setups.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getHolderPass } from '../holders/repo.ts';
import { captureCredentialKeyEnv, ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { startCredentialTransfer } from '../passes/credential-transfer.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { scannerActor, withRole } from './actor.ts';
import { snapshotCredentialEnv } from './credential-input.ts';
import { liveAttachment, scanHub } from './live.ts';
import { livePassSnapshot, sealLiveSourceProof } from './live-provenance.ts';
import { getScanner } from './repo-device.ts';
import { candidateById } from './repo-lookup.ts';
import { stagedCredentialTransfer } from './repo-scan-hub-test-fixtures.ts';
import { readScannerScope } from './repo-scope.ts';
import { setSetupWatchStmt } from './repo-setups-test-support.ts';
import { bindScanningSession } from './scanning-workspace.ts';
import { boundStaff } from './staff-binding.ts';
import { proofedScanActor, type ScanKit, setupScanKit } from './test-kit.ts';

export let kit: ScanKit;
export let template: string;
beforeAll(async () => {
  kit = await setupScanKit();
  await ensureCredentialRefKeyset(kit.env.DB, kit.env);
  template = await kit.scanTemplate('Live membership', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
});
export async function beginCredentialTransfer(passId: string, holderEmail = 'next@example.test') {
  const expected = await getHolderPass(kit.env.DB, passId, null);
  const original = await candidateById(kit.env.DB, kit.org.id, passId);
  if (!expected || !original) throw new Error('Missing transfer pass.');
  const ready = Promise.withResolvers<void>();
  const blocked = Promise.withResolvers<void>();
  const originalPut = kit.env.BUCKET.put.bind(kit.env.BUCKET);
  const spy = vi.spyOn(kit.env.BUCKET, 'put').mockImplementation(async (key, value, options) => {
    if (key.startsWith(`passes/${passId}/`)) {
      ready.resolve();
      await blocked.promise;
    }
    return originalPut(key, value, options);
  });
  const pending = startCredentialTransfer(
    jobCtxOf(kit),
    { type: 'system', id: null },
    passId,
    { holderEmail, ownerUserId: null },
    null,
    { kind: 'tenant-holder', expected },
  );
  try {
    await Promise.race([
      ready.promise,
      pending.then(() => {
        throw new Error('Transfer finished before staging.');
      }),
    ]);
    const staged = await stagedCredentialTransfer(kit.env.DB, passId);
    expect(staged).toEqual({
      credential_generation: original.pass.credentialGeneration + 1,
      pending: 1,
    });
  } catch (error) {
    blocked.resolve();
    spy.mockRestore();
    await pending.catch(() => undefined);
    throw error;
  }
  return async () => {
    blocked.resolve();
    try {
      await pending;
    } finally {
      spy.mockRestore();
    }
  };
}
export async function screen(
  role: 'monitor' | 'customer',
  ids: string[],
  allOrg = false,
  settings: Record<string, unknown> = {},
) {
  const device = await kit.scanner({ deviceRole: role, templateIds: [], settings });
  await setSetupWatchStmt(kit.env.DB, kit.org.id, device.id, { scannerIds: ids, allOrg }).run();
  const row = await getScanner(kit.env.DB, device.id);
  if (!row?.tokenHash || !row.expiresAt || !row.csrfSecret)
    throw new Error('Missing paired screen fixture.');
  const scope = await readScannerScope(kit.env.DB, row, row.staffId);
  const actor = scannerActor(kit.ctx, row, row.mode, 'cookie', scope);
  await bindScanningSession(kit.ctx, actor);
  withRole(actor, actor.settings.staffSignIn ? await boundStaff(kit.ctx, row, scope.staff) : null);
  const attachment = liveAttachment(kit.ctx, await proofedScanActor(kit.ctx, actor));
  return { ...device, attachment };
}
export const hub = () => scanHub(kit.ctx, kit.org.id, 'live');
export const row = (id: string, more: Partial<ScanLiveRow> = {}): ScanLiveRow => ({
  id: kit.ctx.ids.token(16),
  at: Date.now(),
  scannerId: id,
  scannerName: 'Front door',
  passId: null,
  holder: 'Private Member',
  photoUrl: null,
  kind: 'ok',
  direction: 'in',
  label: 'Checked in',
  presented: true,
  ...more,
});
export const proven = async (body: ScanLiveRow) => {
  const keyEnv = captureCredentialKeyEnv(kit.env);
  const ctx = { ...kit.ctx, env: snapshotCredentialEnv(kit.env, keyEnv) };
  const source = await getScanner(kit.env.DB, body.scannerId);
  if (!source) throw new Error('Missing source scanner.');
  const scope = await readScannerScope(kit.env.DB, source, source.staffId);
  const actor = scannerActor(
    kit.ctx,
    source,
    source.mode,
    source.kind === 'terminal' ? 'bearer' : 'cookie',
    scope,
  );
  await bindScanningSession(kit.ctx, actor);
  withRole(
    actor,
    !actor.terminal && actor.settings.staffSignIn
      ? await boundStaff(kit.ctx, source, scope.staff)
      : null,
  );
  const safeActor = await proofedScanActor(ctx, actor);
  const candidate = body.passId ? await candidateById(kit.env.DB, source.orgId, body.passId) : null;
  if (body.passId && !candidate) throw new Error('Missing source pass.');
  if (!safeActor.credentialKeysetCommitment) throw new Error('Missing credential context.');
  if (candidate && candidate.credentialKeysetCommitment !== safeActor.credentialKeysetCommitment)
    throw new Error('Source credential keyset changed.');
  const credentialContext = {
    credentialKeysetCommitment: safeActor.credentialKeysetCommitment,
    credentialTombstoneRefs: candidate?.credentialTombstoneRefs ?? [],
    otherModeCredentialTombstoneRefs: candidate?.otherModeCredentialTombstoneRefs ?? [],
  };
  const sourceProof = await sealLiveSourceProof(keyEnv, {
    actor: safeActor,
    credentialContext,
    eventId: body.id,
    passId: body.passId,
    passSnapshot: candidate ? await livePassSnapshot(keyEnv, candidate) : null,
    at: body.at,
  });
  return { ...body, sourceProof };
};
export const publish = async (body: ScanLiveRow) =>
  hub().publish({ orgId: kit.org.id, mode: 'live', row: await proven(body) });
export const next = (socket: WebSocket) =>
  new Promise<{ rows: ScanLiveRow[] }>((resolve) =>
    socket.addEventListener('message', (event) => resolve(JSON.parse(String(event.data))), {
      once: true,
    }),
  );

export async function photoFixture() {
  const source = await kit.scanner({ templateIds: [template] });
  const monitor = await screen('monitor', [source.id]);
  const pass = await kit.scanPass(template);
  const png = btoa(String.fromCharCode(...makePng(270, 270)));
  await putMemberPhoto(
    kit.ctx,
    { type: 'system', id: null },
    pass.id,
    { png, includeInPass: false },
    null,
  );
  const event = row(source.id, { passId: pass.id });
  await publish(event);
  const result = (await hub().snapshot(monitor.attachment)).rows.find(
    (item) => item.id === event.id,
  );
  if (!result?.photoUrl) throw new Error('Missing live photo fixture.');
  return {
    source,
    monitor,
    pass,
    png,
    event,
    path: result.photoUrl.replace('/api/v1/scan', ''),
  };
}

export function observeCancellation(object: R2ObjectBody, onCancel: () => void): R2ObjectBody {
  const reader = object.body.getReader();
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const result = await reader.read();
        if (result.done) controller.close();
        else controller.enqueue(result.value);
      },
      async cancel(reason) {
        onCancel();
        await reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return new Proxy(object, {
    get(target, property) {
      if (property === 'body') return body;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
