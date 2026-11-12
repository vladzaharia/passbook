import { describe, expect, it } from 'vitest';
import { makeScanner, makeSession } from '../../../../test/helpers/index.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { first, run } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getHolderPass } from '../holders/repo.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import {
  finishCredentialTransfer,
  startCredentialTransfer,
} from '../passes/credential-transfer.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { setupSamsungCallbacks } from '../wallet-providers/callbacks-test-fixtures.ts';
import { getWalletInstanceById, getWalletOperation } from '../wallet-providers/instance.ts';
import { reconcileWalletInstance } from '../wallet-providers/lifecycle.ts';
import { runWalletProviderOperation } from '../wallet-providers/sync-operation.ts';
import { scannerActor, withRole } from './actor.ts';
import { createScannerStore } from './auth-store.ts';
import { scanCredentialKeys } from './credential-input.ts';
import { getScanner } from './repo-device.ts';
import { getScanRow } from './repo-feed.ts';
import { readScannerScope } from './repo-scope.ts';
import { searchPasses } from './repo-search.ts';
import { effects, raceCardHistory } from './repo-transfer-history-test-fixtures.ts';
import { verifyScanEventProvenance } from './scan-event-proof.ts';
import { key, ORIGIN, proofedScanActor, setupScanKit } from './test-kit.ts';

const OLD_EMAIL = 'first-holder-transfer@example.test';
const NEW_EMAIL = 'next-holder-transfer@example.test';
const TITLE = 'Alex Morgan';
// Short enough that the display's history row shows it whole.
const SCANNER = 'Transfer north door';

describe('provider-backed transfer and scanner history', () => {
  it('fences captured and historical pass output while pending and never revives the old signed generation', async () => {
    // An unpromoted, delivered Samsung ref is a real provider incarnation. Its expiry can prove
    // no external card exists, allowing the real retirement path without inventing a provider reply.
    const scanKit = await setupScanKit();
    const templateId = await scanKit.scanTemplate('Transfer history card', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
      display: {
        v: 1,
        holder: '{{inputs.memberName}}',
        header: { subtitle: '{{history.lastScan.action}}' },
        panels: [
          {
            id: 'p_history',
            rows: [
              { id: 'r_history', type: 'history', source: 'scans', show: ['action', 'where'] },
            ],
          },
        ],
      },
    });
    const template = await scanKit.registry.resolve(templateId);
    const apple = await approveAppleRelease(scanKit, { templateId, version: template.version });
    const issued = await scanKit.scanPass(
      templateId,
      { memberName: TITLE },
      { holderEmail: OLD_EMAIL },
    );
    const t = await setupSamsungCallbacks({
      promoted: false,
      source: { kit: { ...scanKit, template }, apple, pass: issued, barcode: 'qr' },
    });
    const { kit, pass } = t;
    const db = kit.env.DB;
    if (!pass.scanCode) throw new Error('The issued pass needs its original scan credential.');
    const oldCode = pass.scanCode;
    const other = await scanKit.scanPass(templateId, { memberName: 'Alex Guest' });
    const scanner = await makeScanner(kit.fx, {
      orgId: kit.org.id,
      templateIds: [pass.templateId],
    });
    await run(db, 'UPDATE scanners SET name = ? WHERE id = ?', [SCANNER, scanner.id]);
    const session = await makeSession(kit.fx, { userId: t.auth.userId, roles: ['admin', 'user'] });
    const app = createApp({
      stores: {
        ...denyAllStores,
        sessions: createSessionStore(kit.env, kit.clock),
        scanners: createScannerStore(kit.env, kit.clock),
      },
      clock: kit.clock,
    });
    const post = (path: string, body: unknown) =>
      Promise.resolve(
        app.request(
          `${ORIGIN}/api/v1/scan${path}`,
          {
            method: 'POST',
            headers: { ...scanner.headers, 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
          kit.env,
        ),
      );
    const scannerGet = (path: string) =>
      Promise.resolve(
        app.request(`${ORIGIN}/api/v1/scan${path}`, { headers: scanner.headers }, kit.env),
      );
    const consoleGet = (path: string) =>
      Promise.resolve(
        app.request(
          `${ORIGIN}/api/v1/scans${path}`,
          { headers: { ...session.headers, origin: ORIGIN } },
          kit.env,
        ),
      );
    async function json<T>(response: Response): Promise<T> {
      expect(response.status).toBe(200);
      return response.json() as Promise<T>;
    }
    const request = {
      idempotencyKey: key(),
      input: { code: oldCode, method: 'camera' as const },
      clientTs: kit.clock.now(),
      actionId: 'check_in',
    };
    const resolve = (input: object) =>
      post('/resolve', { idempotencyKey: key(), input, clientTs: kit.clock.now() });
    const lookup = (q = 'Alex') => post('/lookup', { q });
    const page = () => consoleGet(`?orgId=${kit.org.id}`);

    const signedRequest = await t.token();
    expect((await t.call({ token: signedRequest })).status).toBe(401);
    const original = await json<ScanOutcome>(await post('/actions', request));
    expect(original).toMatchObject({
      kind: 'ok',
      action: { id: 'check_in', label: 'Check in' },
      replay: false,
    });
    if (!original.scanId || original.at === null)
      throw new Error('A real check-in must be committed.');
    const scanId = original.scanId;
    const event = await first<{ data: string }>(
      db,
      "SELECT data FROM pass_events WHERE pass_id = ? AND json_extract(data, '$.scanId') = ?",
      [pass.id, scanId],
    );
    if (!event) throw new Error('The check-in must have its pass event.');
    const proof = JSON.parse(event.data) as {
      authority: {
        credentialGeneration: number;
        noPendingTransfer: boolean;
      };
    };
    expect(proof.authority).toMatchObject({
      credentialGeneration: pass.credentialGeneration,
      noPendingTransfer: true,
    });
    // Plain event-time facts: the event carries no MAC.
    expect(proof.authority).not.toHaveProperty('eventProof');
    expect(event.data).not.toContain(TITLE);
    expect(event.data).not.toContain(OLD_EMAIL);
    const captured = (await getScanRow(db, scanId, kit.clock.now(), 'live'))?.eventProof;
    if (!captured) throw new Error('The committed check-in needs its original proof snapshot.');
    expect(await verifyScanEventProvenance(kit.env, captured.event, captured.scan)).toBe(true);

    const beforeCard = await json<ScanOutcome>(
      await resolve({ passId: pass.id, method: 'manual' }),
    );
    expect(beforeCard).toMatchObject({ kind: 'ready', card: { passId: pass.id } });
    expect(beforeCard.card?.lastScans).toContainEqual(
      expect.objectContaining({
        scanId,
        actionLabel: 'Check in',
        scannerName: SCANNER,
      }),
    );
    expect(JSON.stringify(beforeCard.card?.display)).toContain('Check in');
    expect(JSON.stringify(beforeCard.card?.display)).toContain(SCANNER);
    const beforePage = await json<{ items: unknown[] }>(await page());
    expect(beforePage.items).toContainEqual(
      expect.objectContaining({
        id: scanId,
        passId: pass.id,
        passTitle: TITLE,
        actionId: 'check_in',
        scannerName: SCANNER,
      }),
    );
    const beforeLookup = await json<{ items: { passId: string; lastScanAt: number | null }[] }>(
      await lookup(),
    );
    expect(beforeLookup.items).toContainEqual(
      expect.objectContaining({ passId: pass.id, lastScanAt: original.at }),
    );
    const beforeRecent = await json<{ items: unknown[] }>(await scannerGet('/scans'));
    expect(beforeRecent.items).toContainEqual(
      expect.objectContaining({
        scanId,
        title: TITLE,
        actionLabel: 'Check in',
        undoable: true,
      }),
    );
    expect(await json<unknown>(await scannerGet('/summary'))).toMatchObject({
      total: 1,
      ok: 1,
      byAction: [{ actionId: 'check_in', label: 'Check in', count: 1, amount: 0 }],
    });

    const expected = await getHolderPass(db, pass.id, null);
    if (!expected) throw new Error('Missing current holder snapshot.');
    const race = raceCardHistory(db, () =>
      startCredentialTransfer(
        jobCtxOf(kit),
        { type: 'system', id: null },
        pass.id,
        { holderEmail: NEW_EMAIL, ownerUserId: null },
        null,
        { kind: 'tenant-holder', expected },
      ),
    );
    Object.assign(kit.env, { DB: race.proxy });
    let racingResponse: Response;
    try {
      racingResponse = await resolve({ passId: pass.id, method: 'manual' });
    } finally {
      Object.assign(kit.env, { DB: db });
    }
    expect(race.fired()).toBe(true);
    const transfer = race.transfer();
    expect(transfer).toMatchObject({ state: 'pending', transferId: expect.any(String) });
    if (!transfer) throw new Error('The interleaved transfer did not start.');
    const pending = await getPass(db, pass.id);
    if (!pending) throw new Error('Missing pending pass.');
    expect(pending).toMatchObject({
      holderEmail: OLD_EMAIL,
      credentialGeneration: pass.credentialGeneration + 1,
      linkGeneration: pass.linkGeneration + 1,
      scanCode: oldCode,
    });
    expect(pending.downloadToken).not.toBe(pass.downloadToken);
    expect(
      await first(
        db,
        'SELECT state, source_generation, target_generation FROM pass_credential_transfers WHERE id = ?',
        [transfer.transferId],
      ),
    ).toEqual({
      state: 'pending',
      source_generation: pass.credentialGeneration,
      target_generation: pass.credentialGeneration + 1,
    });
    const secrets = [
      pass.id,
      TITLE,
      OLD_EMAIL,
      NEW_EMAIL,
      SCANNER,
      'Check in',
      oldCode,
      pass.authToken,
      pass.downloadToken,
      pending.downloadToken,
      t.refId,
    ];
    const noSecrets = (body: string) => {
      for (const secret of secrets) expect(body).not.toContain(secret);
    };
    expect(racingResponse.status).toBe(200);
    const racedText = await racingResponse.text();
    expect(JSON.parse(racedText)).toMatchObject({
      kind: 'refused',
      reason: 'not_found',
      card: null,
      template: null,
    });
    noSecrets(racedText);

    // The pending pass must be excluded by the SQL page itself, not merely removed after its cap.
    const scannerRow = await getScanner(db, scanner.id);
    if (!scannerRow) throw new Error('Missing scanner row.');
    const scope = await readScannerScope(db, scannerRow, null);
    const actor = withRole(
      await proofedScanActor(kit.ctx, scannerActor(kit.ctx, scannerRow, 'live', 'cookie', scope)),
      null,
    );
    const { credentialTombstoneRefs, credentialKeysetCommitment } = await scanCredentialKeys(
      kit.env,
      actor.orgId,
      actor.mode,
      'Alex',
      false,
    );
    const candidates = await searchPasses(
      db,
      actor,
      'Alex',
      null,
      undefined,
      kit.clock.now(),
      0,
      credentialTombstoneRefs,
      credentialKeysetCommitment,
    );
    expect(candidates.map((row) => row.id)).toEqual([other.id]);
    const pendingLookup = await json<{ items: { passId: string }[] }>(await lookup());
    expect(pendingLookup.items.map((row) => row.passId)).toEqual([other.id]);
    noSecrets(JSON.stringify(pendingLookup));
    for (const credential of [oldCode, pass.downloadToken, pending.downloadToken]) {
      const result = await json<{ items: unknown[] }>(await lookup(credential));
      expect(result.items).toEqual([]);
      noSecrets(JSON.stringify(result));
    }

    const pendingEffects = await effects(db, pass.id);
    for (const input of [
      { passId: pass.id, method: 'manual' },
      { code: oldCode, method: 'camera' },
    ]) {
      const response = await resolve(input);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({
        kind: 'refused',
        reason: 'not_found',
        card: null,
        template: null,
      });
      noSecrets(text);
    }
    const history = await json<{ items: unknown[] }>(await page());
    expect(history.items).toContainEqual(
      expect.objectContaining({
        id: scanId,
        passId: null,
        templateId: null,
        passTitle: null,
        actionId: null,
        actionLabel: null,
        kind: null,
      }),
    );
    noSecrets(JSON.stringify(history));
    const detail = await json<unknown>(await consoleGet(`/${scanId}`));
    expect(detail).toMatchObject({ id: scanId, passId: null, passTitle: null, actionId: null });
    noSecrets(JSON.stringify(detail));
    const exported = await consoleGet(
      `/export?orgId=${kit.org.id}&from=${kit.clock.now() - 86_400_000}&to=${kit.clock.now() + 86_400_000}`,
    );
    expect(exported.status).toBe(200);
    const csvText = await exported.text();
    expect(
      csvText
        .replace(/^\uFEFF/, '')
        .trimEnd()
        .split('\r\n'),
    ).toHaveLength(2);
    noSecrets(csvText);
    const recent = await json<{ items: unknown[] }>(await scannerGet('/scans'));
    expect(recent.items).toContainEqual(
      expect.objectContaining({ scanId, title: null, actionLabel: 'Scan', undoable: false }),
    );
    noSecrets(JSON.stringify(recent));
    const summary = await json<unknown>(await scannerGet('/summary'));
    expect(summary).toMatchObject({ total: 1, ok: 1, byAction: [] });
    noSecrets(JSON.stringify(summary));
    const replay = await json<ScanOutcome>(await post('/actions', request));
    expect(replay).toMatchObject({
      action: null,
      card: null,
      template: null,
      display: null,
      previous: null,
      undoUntil: null,
    });
    noSecrets(JSON.stringify(replay));
    const rejectedKey = key();
    const deniedAction = await json<ScanOutcome>(
      await post('/actions', { ...request, idempotencyKey: rejectedKey }),
    );
    expect(deniedAction).toMatchObject({
      kind: 'refused',
      reason: 'not_found',
      action: null,
      card: null,
    });
    noSecrets(JSON.stringify(deniedAction));
    const rejectedRow = await first<Record<string, unknown>>(
      db,
      'SELECT * FROM scans WHERE actor_key = ? AND idempotency_key = ?',
      [`s:${scanner.id}`, rejectedKey],
    );
    if (rejectedRow) {
      expect(rejectedRow).toMatchObject({
        pass_id: null,
        template_id: null,
        action_id: null,
        action_kind: null,
      });
      noSecrets(JSON.stringify(rejectedRow));
    }
    const undoKey = key();
    const deniedUndo = await post(`/scans/${scanId}/undo`, { idempotencyKey: undoKey });
    expect(deniedUndo.status).toBe(404);
    noSecrets(await deniedUndo.text());
    expect(
      await first(db, 'SELECT id FROM scans WHERE actor_key = ? AND idempotency_key = ?', [
        `s:${scanner.id}`,
        undoKey,
      ]),
    ).toBeNull();
    expect(await effects(db, pass.id)).toEqual(pendingEffects);
    expect((await t.call({ token: await t.token() })).status).toBe(401);
    expect(await finishCredentialTransfer(jobCtxOf(kit), transfer.transferId)).toMatchObject({
      state: 'pending',
    });

    // Let the issued offer expire, then perform the actual provider reconciliation and retirement.
    kit.clock.advance(300_001);
    const walletScope = {
      orgId: pass.orgId,
      mode: pass.mode,
      provider: 'samsung' as const,
      instanceId: t.operation.instanceId,
      credentialKeysetCommitment: t.credentialKeysetCommitment,
    };
    const instance = await getWalletInstanceById(db, walletScope);
    if (!instance) throw new Error('Missing provider instance.');
    expect(await reconcileWalletInstance(kit.ctx, instance)).toBe('scheduled');
    const retiring = await getWalletInstanceById(db, walletScope);
    if (!retiring) throw new Error('Missing retiring instance.');
    const revoke = await getWalletOperation(db, {
      ...walletScope,
      version: retiring.desiredVersion,
    });
    if (!revoke) throw new Error('Missing real provider revoke operation.');
    expect(revoke).toMatchObject({ kind: 'revoke', state: 'pending' });
    expect(await runWalletProviderOperation(kit.ctx, revoke)).toBe('completed');
    expect(await getWalletInstanceById(db, walletScope)).toMatchObject({ lifecycle: 'retired' });
    const retiredCallback = await t.call({ token: await t.token() });
    expect(retiredCallback.status).toBe(204);
    expect(await retiredCallback.text()).toBe('');
    expect(await finishCredentialTransfer(jobCtxOf(kit), transfer.transferId)).toMatchObject({
      state: 'completed',
    });
    const fresh = await getPass(db, pass.id);
    const completedEffects = await effects(db, pass.id);
    if (!fresh?.scanCode) throw new Error('Missing completed transfer credential.');
    expect(fresh).toMatchObject({
      holderEmail: NEW_EMAIL,
      credentialGeneration: pass.credentialGeneration + 1,
    });
    expect(fresh.scanCode).not.toBe(oldCode);
    expect(fresh.serial).not.toBe(pass.serial);
    expect(fresh.authToken).not.toBe(pass.authToken);
    expect(
      await first(db, 'SELECT state FROM pass_credential_transfers WHERE id = ?', [
        transfer.transferId,
      ]),
    ).toEqual({ state: 'completed' });
    expect(
      await first(
        db,
        "SELECT data FROM pass_events WHERE pass_id = ? AND json_extract(data, '$.scanId') = ?",
        [pass.id, scanId],
      ),
    ).toEqual(event);
    // The old signature is still cryptographically valid; only its authority has expired.
    expect(await verifyScanEventProvenance(kit.env, captured.event, captured.scan)).toBe(true);

    const oldResult = await json<ScanOutcome>(await resolve({ code: oldCode, method: 'camera' }));
    expect(oldResult).toMatchObject({
      kind: 'refused',
      reason: 'not_found',
      card: null,
      template: null,
    });
    noSecrets(JSON.stringify(oldResult));
    const newResult = await json<ScanOutcome>(
      await resolve({ code: fresh.scanCode, method: 'camera' }),
    );
    expect(newResult).toMatchObject({ kind: 'ready', card: { passId: pass.id } });
    expect(newResult.card?.lastScans?.find((row) => row.scanId === scanId)).toBeUndefined();
    expect(JSON.stringify(newResult.card?.lastScans)).not.toContain(SCANNER);
    expect(JSON.stringify(newResult.card?.lastScans)).not.toContain('Check in');
    expect(JSON.stringify(newResult.card?.display)).not.toContain(SCANNER);
    expect(JSON.stringify(newResult.card?.display)).not.toContain('Check in');
    const afterLookup = await json<{ items: { passId: string; lastScanAt: number | null }[] }>(
      await lookup(),
    );
    expect(afterLookup.items).toContainEqual(
      expect.objectContaining({ passId: pass.id, lastScanAt: null }),
    );
    const afterPage = await json<{ items: unknown[] }>(await page());
    expect(afterPage.items).toContainEqual(
      expect.objectContaining({
        id: scanId,
        passId: null,
        passTitle: null,
        actionId: null,
        actionLabel: null,
      }),
    );
    noSecrets(JSON.stringify(afterPage));
    const afterRecent = await json<{ items: unknown[] }>(await scannerGet('/scans'));
    expect(afterRecent.items).toContainEqual(
      expect.objectContaining({ scanId, title: null, actionLabel: 'Scan', undoable: false }),
    );
    noSecrets(JSON.stringify(afterRecent));
    expect(await json<unknown>(await scannerGet('/summary'))).toMatchObject({ byAction: [] });
    const afterReplay = await json<ScanOutcome>(await post('/actions', request));
    expect(afterReplay).toMatchObject({
      action: null,
      card: null,
      template: null,
      display: null,
      previous: null,
      undoUntil: null,
    });
    noSecrets(JSON.stringify(afterReplay));
    const afterUndoKey = key();
    expect((await post(`/scans/${scanId}/undo`, { idempotencyKey: afterUndoKey })).status).toBe(
      404,
    );
    expect(
      await first(db, 'SELECT id FROM scans WHERE actor_key = ? AND idempotency_key = ?', [
        `s:${scanner.id}`,
        afterUndoKey,
      ]),
    ).toBeNull();
    expect(await effects(db, pass.id)).toEqual(completedEffects);
  }, 180_000);
});
