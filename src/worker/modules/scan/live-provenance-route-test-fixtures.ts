import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { expect, it } from 'vitest';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { scannerActor } from './actor.ts';
import { createScannerStore } from './auth-store.ts';
import { scanHub } from './live.ts';
import { type InternalLiveRow, openLiveSourceProof } from './live-provenance.ts';
import { getScanner } from './repo-device.ts';
import { codeOf, key, type ScanKit } from './test-kit.ts';

export function registerProvenanceRouteTests(context: () => { kit: ScanKit; template: string }) {
  it('publishes a real scanner action using the evaluation keyset when the route actor has none', async () => {
    const { kit, template } = context();
    const scanner = await kit.scanner({ templateIds: [template] });
    const device = await getScanner(kit.env.DB, scanner.id);
    if (!device?.hasScreens) throw new Error('Missing live-capable scanner fixture.');
    const routeActor = scannerActor(kit.ctx, { ...device, csrfSecret: null }, 'live', 'cookie', {
      event: null,
      templateIds: [template],
    });
    expect(routeActor.credentialKeysetCommitment).toBeUndefined();
    const pass = await kit.scanPass(template);
    const app = createApp({
      stores: { ...denyAllStores, scanners: createScannerStore(kit.env, kit.clock) },
      clock: kit.clock,
    });
    const execution = createExecutionContext();
    const response = await app.fetch(
      new Request('https://wallet.test/api/v1/scan/actions', {
        method: 'POST',
        headers: { ...scanner.headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          input: codeOf(pass),
          actionId: 'check_in',
          clientTs: kit.clock.now(),
          idempotencyKey: key(),
        }),
      }),
      kit.env,
      execution,
    );
    expect(response.status).toBe(200);
    const outcome = await response.json();
    expect(outcome).toMatchObject({ kind: 'ok' });
    await waitOnExecutionContext(execution);
    const hub = scanHub(kit.ctx, kit.org.id, 'live');
    const rows = await runInDurableObject(hub, async (_object, state) =>
      ((await state.storage.get<InternalLiveRow[]>('recent')) ?? []).filter(
        (entry) => entry.scannerId === scanner.id,
      ),
    );
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) throw new Error('Missing retained route event.');
    const proof = await openLiveSourceProof(kit.env, row.sourceProof);
    if (!proof?.passSnapshot) throw new Error('Missing route source proof.');
    expect(proof.passId).toBe(pass.id);
    expect(proof.actor.scanner?.csrfSecret).toBeNull();
    expect(proof.actor.scannerCsrfProof).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(proof.actor.credentialKeysetCommitment).toBe(
      proof.credentialContext.credentialKeysetCommitment,
    );
    expect(proof.passSnapshot.credentialKeysetCommitment).toBe(
      proof.credentialContext.credentialKeysetCommitment,
    );
    expect(proof.credentialContext.credentialTombstoneRefs.length).toBeGreaterThan(0);
    expect(proof.credentialContext.otherModeCredentialTombstoneRefs.length).toBeGreaterThan(0);
    expect(proof.passSnapshot.credentialTombstoneRefs).toEqual(
      proof.credentialContext.credentialTombstoneRefs,
    );
    expect(proof.passSnapshot.otherModeCredentialTombstoneRefs).toEqual(
      proof.credentialContext.otherModeCredentialTombstoneRefs,
    );
    const rawCsrf = scanner.headers['x-csrf-token'];
    if (!rawCsrf || !pass.scanCode) throw new Error('Missing scanner credential fixture.');
    expect(JSON.stringify(proof)).not.toContain(rawCsrf);
    expect(JSON.stringify(proof)).not.toContain(pass.scanCode);
    expect(JSON.stringify(row)).not.toContain(rawCsrf);
    expect(JSON.stringify(row)).not.toContain(pass.scanCode);
  });
}
