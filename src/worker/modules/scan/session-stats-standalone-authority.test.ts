import { describe, expect, it } from 'vitest';
import { makePass, makeScanner, makeTemplate } from '../../../../test/helpers/index.ts';
import { ScanCountsSchema } from '../../../shared/contracts/scan.ts';
import { ScanSessionSchema } from '../../../shared/contracts/scan-session.ts';
import { ScanningSessionDetailSchema } from '../../../shared/contracts/scanning-sessions.ts';
import { run } from '../../platform/db.ts';
import { credentialRefKeysetCommitment } from '../passes/credential-keyset.ts';
import { scanSecretSlots } from './repo-secret-binds.ts';
import {
  atCountBatch,
  freshFixture,
  insertExistingReference,
  singleton,
  withMutableScannerSecret,
} from './repo-session-stats-authority-test-fixtures.ts';
import { setupScanKit } from './test-kit.ts';

describe('standalone scanner statistics authority', () => {
  it('bootstraps and counts only same-session ledger-visible successes for a fresh device', async () => {
    const f = await freshFixture();
    const scanner = await makeScanner(f.fx, { orgId: f.org.id });
    const peer = await makeScanner(f.fx, { orgId: f.org.id });
    const other = await makeScanner(f.fx, { orgId: f.org.id });
    for (const device of [scanner, peer]) {
      await run(
        f.env.DB,
        `INSERT INTO scanning_devices (scanner_id,session_id,org_id,mode)
        VALUES (?,?,?,'live')`,
        [device.id, f.id, f.org.id],
      );
    }
    const template = makeTemplate({ id: f.fx.ids.id(), orgId: f.org.id });
    const pass = await makePass(f.fx, { orgId: f.org.id, template: template.resolved });
    const addScan = async (
      scannerId: string,
      passId: string | null,
      at: number,
      state = 'done',
    ) => {
      const id = f.fx.ids.id();
      await run(
        f.env.DB,
        `INSERT INTO scans
        (id,org_id,mode,pass_id,template_id,scanner_id,actor_type,actor_id,actor_key,
         idempotency_key,request_hash,method,state,outcome,action_id,action_kind,at)
        VALUES (?,?,'live',?,?,?,'scanner',?,?,?,?,'camera',?,'ok','check_in','check_in',?)`,
        [
          id,
          f.org.id,
          passId,
          template.resolved.id,
          scannerId,
          scannerId,
          `s:${scannerId}`,
          id,
          id,
          state,
          at,
        ],
      );
    };
    await addScan(scanner.id, pass.id, f.clock.now());
    await addScan(peer.id, pass.id, f.clock.now());
    await addScan(scanner.id, pass.id, f.clock.now(), 'pending');
    await addScan(scanner.id, null, f.clock.now());
    await addScan(scanner.id, pass.id, f.clock.now() - 86_400_000);
    await addScan(other.id, pass.id, f.clock.now());
    expect(await singleton(f)).toBeNull();
    const { result, captured } = await atCountBatch(
      f.env,
      () => f.request('/scan/stats', scanner.headers),
      async () => {},
    );
    expect(result.status).toBe(200);
    expect(ScanCountsSchema.parse(await result.json())).toMatchObject({
      today: 2,
      event: null,
      asOf: f.clock.now(),
    });
    expect(
      captured.some(
        (entry) =>
          entry.sql.includes('FROM scans s') &&
          entry.sql.includes('scan_retention_proofs') &&
          entry.sql.includes("s.outcome='ok'"),
      ),
    ).toBe(true);
    expect(await singleton(f)).toEqual({ commitment: f.proof.credentialKeysetCommitment });
    const consoleResponse = await f.request(`/scanning-sessions/${f.id}`);
    expect(consoleResponse.status).toBe(200);
    expect(ScanningSessionDetailSchema.parse(await consoleResponse.json())).toMatchObject({
      id: f.id,
      today: 2,
      deviceCount: 2,
      onlineCount: 2,
    });
    const deviceResponse = await f.request('/scan/session', scanner.headers);
    expect(deviceResponse.status).toBe(200);
    expect(ScanSessionSchema.parse(await deviceResponse.json())).toMatchObject({
      counts: { today: 2 },
      workspace: { session: { id: f.id, today: 2 } },
    });
  });

  it('keeps the event-cache keyset and scanner CSRF fences as labeled scalar binds', async () => {
    const kit = await setupScanKit();
    const templateId = await kit.scanTemplate('Stats event', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const event = await kit.event({ templateIds: [templateId] });
    const scanner = await kit.scanner({ eventId: event.id });
    const secret = scanner.headers['x-csrf-token'];
    if (!secret) throw new Error('Missing scanner CSRF secret');
    const commitment = await credentialRefKeysetCommitment(kit.env);
    const { result, captured } = await atCountBatch(
      kit.env,
      () => kit.get(scanner.headers, '/stats'),
      async () => {},
    );
    expect(result.status).toBe(200);
    expect(captured.some((entry) => entry.sql.includes('UPDATE scan_events SET expected ='))).toBe(
      true,
    );
    let proofBinds = 0;
    for (const entry of captured) {
      const slots = scanSecretSlots(entry.sql, entry.params.length);
      if (!slots) throw new Error('Malformed statistics bind labels');
      for (const [index, value] of entry.params.entries()) {
        if (value === commitment) {
          expect(slots[index]?.label).toBe('proof');
          proofBinds++;
        } else if (value === secret) {
          throw new Error('A stats read binds no CSRF secret.');
        } else if (typeof value === 'string' && (value.startsWith('[') || value.startsWith('{'))) {
          expect(value).not.toContain(commitment);
          expect(value).not.toContain(secret);
        }
      }
    }
    expect(proofBinds).toBeGreaterThan(0);
  });

  it.each(['revoked', 'csrf'] as const)(
    'rejects %s scanner authority at the final count batch without bootstrapping',
    async (change) => {
      const f = await freshFixture();
      const scanner = await makeScanner(f.fx, { orgId: f.org.id });
      const secret = scanner.headers['x-csrf-token'];
      if (!secret) throw new Error('Missing scanner CSRF secret');
      const race = () =>
        atCountBatch(
          f.env,
          () => f.request('/scan/stats', scanner.headers),
          async (db) => {
            if (change === 'revoked')
              await run(db, 'UPDATE scanners SET revoked_at=? WHERE id=?', [
                f.clock.now(),
                scanner.id,
              ]);
            else
              await run(db, 'UPDATE scanners SET csrf_secret=? WHERE id=?', [
                'replaced-scanner-secret',
                scanner.id,
              ]);
          },
        );
      const { result } =
        change === 'csrf'
          ? await withMutableScannerSecret(f.env.DB, scanner.id, secret, race)
          : await race();
      expect(result.status).toBe(401);
      expect(await result.json()).toMatchObject({ code: 'SCANNER_UNAUTHENTICATED' });
      expect(await singleton(f)).toBeNull();
    },
  );

  it('returns unavailable when references survive a missing singleton', async () => {
    const f = await freshFixture();
    const scanner = await makeScanner(f.fx, { orgId: f.org.id });
    await insertExistingReference(f);
    const response = await f.request('/scan/stats', scanner.headers);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE' });
    expect(await singleton(f)).toBeNull();
  });
});
