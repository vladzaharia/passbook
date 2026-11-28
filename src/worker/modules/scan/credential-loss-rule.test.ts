import { describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { beforeBatch } from './batch-interceptor-test-support.ts';
import { RACE_ORG_NAME, RACE_STAFF_BIND } from './race-tags.ts';
import { setupScanKit } from './test-kit.ts';

/**
 * One credential-loss rule (`scannerCredentialLost`) for the session read and the staff bind: a
 * replaced token prefix or a rotated CSRF secret unpairs; a pair code issued for the same token or a
 * mode move moves the credential epoch too, but the device stays paired and rereads (409).
 */
const changes = {
  'token prefix replaced': "token_prefix = 'p-' || id",
  'CSRF secret rotated': "csrf_secret = 'rotated-csrf-secret'",
  'pair code issued': "pair_code_hash = 'code-' || id, pair_expires_at = 9999999999999",
  'mode moved': "mode = 'test'",
} as const;
type Change = keyof typeof changes;
const lost = (change: Change) => change !== 'pair code issued' && change !== 'mode moved';

const move = (id: string, change: Change) => async (db: D1Database) =>
  void (await run(
    db,
    `UPDATE scanners SET ${changes[change]}, updated_at = updated_at + 1 WHERE id = ?`,
    [id],
  ));

describe('the session read classifies a lost credential with the shared rule', () => {
  it.each(Object.keys(changes) as Change[])('%s during the read', async (change) => {
    const kit = await setupScanKit();
    const template = await kit.scanTemplate('Session read', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const scanner = await kit.scanner({ templateIds: [template] });
    expect((await kit.get(scanner.headers, '/session')).status).toBe(200);
    const { result, fired } = await beforeBatch(
      kit.env,
      RACE_ORG_NAME,
      move(scanner.id, change),
      () => kit.get(scanner.headers, '/session'),
    );
    expect(fired).toBe(true);
    expect(await result.json()).toMatchObject(
      lost(change)
        ? { status: 401, code: 'SCANNER_REPAIR' }
        : { status: 409, code: 'SCAN_CONFIG_CHANGED' },
    );
  });
});

describe('the staff bind classifies a lost credential with the shared rule', () => {
  it.each(Object.keys(changes) as Change[])('%s before the bind commits', async (change) => {
    const kit = await setupScanKit();
    const template = await kit.scanTemplate('Staff bind', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const scanner = await kit.scanner({
      templateIds: [template],
      settings: { staffSignIn: true },
    });
    const person = await kit.staff('door', 'Dana');
    const { result, fired } = await beforeBatch(
      kit.env,
      RACE_STAFF_BIND,
      move(scanner.id, change),
      () => kit.post(scanner.headers, '/staff', { staffId: person.id, pin: person.pin }),
    );
    expect(fired).toBe(true);
    expect(await result.json()).toMatchObject(
      lost(change)
        ? { status: 401, code: 'SCANNER_REPAIR' }
        : { status: 409, code: 'SCAN_CONFIG_CHANGED' },
    );
  });

  it('binds when nothing moved (positive control)', async () => {
    const kit = await setupScanKit();
    const template = await kit.scanTemplate('Staff bind control', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const scanner = await kit.scanner({
      templateIds: [template],
      settings: { staffSignIn: true },
    });
    const person = await kit.staff('door', 'Dana');
    const response = await kit.post(scanner.headers, '/staff', {
      staffId: person.id,
      pin: person.pin,
    });
    expect(response.status).toBe(200);
  });
});
