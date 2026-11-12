import { describe, expect, it } from 'vitest';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { createScannerStore } from './auth-store.ts';
import { createPairing } from './pairing.ts';
import { pairHere, replaceTerminalToken } from './pairing-token.ts';
import {
  atCommit,
  kit,
  member,
  ORIGIN,
  passState,
  request,
  scannerPath,
  scannerState,
  setupPairingAuthorityFixture,
  templateId,
} from './repo-pairing-authority-split-test-fixtures.ts';
import { getConsoleScanner } from './repo-scanners.ts';
import { createSamplePass } from './sample-pass.ts';
import { grantScanMembership } from './test-kit.ts';

setupPairingAuthorityFixture();

describe('pairing tenant authority', () => {
  const actions = [
    { action: 'pairing', target: 'code', kind: 'device' },
    { action: 'pair-here', target: 'credential', kind: 'device' },
    { action: 'token', target: 'credential', kind: 'terminal' },
    { action: 'sample-pass', target: 'pass', kind: 'device' },
  ] as const;
  const changes = ['revoked', 'regranted', 'session revoked'] as const;

  for (const { action, target, kind } of actions) {
    for (const change of changes) {
      it(`does not ${action} when authority is ${change} at commit`, async () => {
        const actor = await member();
        const scanner = await kit.scanner({
          kind,
          mode: action === 'sample-pass' ? 'test' : 'live',
          templateIds: [templateId],
        });
        let previousCode: string | undefined;
        if (action === 'pairing') {
          const issued = await request(
            'POST',
            scannerPath(scanner.id, 'pairing'),
            actor.session.headers,
          );
          expect(issued.status).toBe(200);
          previousCode = ((await issued.json()) as { code: string }).code;
        }
        const before = await scannerState(scanner.id);
        const beforePass = action === 'sample-pass' ? await passState() : null;
        const response = await atCommit(
          target,
          async (db) => {
            if (change === 'session revoked') {
              await run(db, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
                kit.clock.now(),
                actor.sessionId,
              ]);
            } else {
              await run(db, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
                kit.clock.now(),
                actor.membershipId,
              ]);
              if (change === 'regranted')
                await grantScanMembership(kit.fx, kit.org.id, actor.user.id);
            }
          },
          () => request('POST', scannerPath(scanner.id, action), actor.session.headers),
        );
        expect([403, 409, 412]).toContain(response.status);
        expect(response.headers.get('set-cookie')).toBeNull();
        expect(await scannerState(scanner.id)).toEqual(before);
        if (beforePass) expect(await passState()).toEqual(beforePass);
        if (previousCode) {
          expect((await request('POST', '/scan/pair', {}, { code: previousCode })).status).toBe(
            200,
          );
        }
      }, 60_000);
    }
  }

  for (const { action, target, kind } of actions.filter((item) => item.action !== 'sample-pass')) {
    it(`does not ${action} after the scanner credential rotates`, async () => {
      const actor = await member();
      const scanner = await kit.scanner({ kind, templateIds: [templateId] });
      let previousCode: string | undefined;
      if (action === 'pairing') {
        const issued = await request(
          'POST',
          scannerPath(scanner.id, 'pairing'),
          actor.session.headers,
        );
        expect(issued.status).toBe(200);
        previousCode = ((await issued.json()) as { code: string }).code;
      }
      const snapshotSql =
        'SELECT updated_at, token_hash, token_prefix, pair_code_hash, pair_expires_at FROM scanners WHERE id = ?';
      const before = await first<{
        updated_at: number;
        token_hash: string | null;
        token_prefix: string | null;
        pair_code_hash: string | null;
        pair_expires_at: number | null;
      }>(kit.env.DB, snapshotSql, [scanner.id]);
      if (!before) throw new Error('Expected scanner fixture.');
      const audit = await all(
        kit.env.DB,
        'SELECT * FROM audit_log WHERE target_id = ? ORDER BY id',
        [scanner.id],
      );
      const response = await atCommit(
        target,
        async (db) => {
          await run(
            db,
            "UPDATE scanners SET token_hash = 'rotated', updated_at = updated_at + 1 WHERE id = ?",
            [scanner.id],
          );
        },
        () => request('POST', scannerPath(scanner.id, action), actor.session.headers),
      );
      expect([403, 409, 412]).toContain(response.status);
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(await first(kit.env.DB, snapshotSql, [scanner.id])).toEqual({
        ...before,
        token_hash: 'rotated',
        updated_at: before.updated_at + 1,
      });
      expect(
        await all(kit.env.DB, 'SELECT * FROM audit_log WHERE target_id = ? ORDER BY id', [
          scanner.id,
        ]),
      ).toEqual(audit);
      if (previousCode) {
        expect((await request('POST', '/scan/pair', {}, { code: previousCode })).status).toBe(200);
      }
    }, 60_000);
  }

  // Membership roles are fixed at grant (0029): the edit is refused, so nothing changes under the
  // request and it succeeds.
  for (const { action, target, kind } of actions.filter((item) => item.action !== 'sample-pass')) {
    it(`still ${action} when a roles edit is refused at commit`, async () => {
      const actor = await member();
      const scanner = await kit.scanner({
        kind,
        templateIds: [templateId],
      });
      const response = await atCommit(
        target,
        async (db) => {
          await expect(
            run(db, 'UPDATE org_memberships SET roles = ? WHERE id = ?', [
              JSON.stringify(['org_admin', 'pass_operator']),
              actor.membershipId,
            ]),
          ).rejects.toThrow(/immutable|roles/i);
        },
        () => request('POST', scannerPath(scanner.id, action), actor.session.headers),
      );
      expect(response.status).toBe(200);
    }, 60_000);
  }

  // A scanner revision is a timestamp, not authority: a bump between read and commit refuses nothing.
  for (const { action, target, kind } of actions.filter((item) => item.action !== 'sample-pass')) {
    it(`${action} survives a scanner revision bump at commit`, async () => {
      const actor = await member();
      const scanner = await kit.scanner({ kind, templateIds: [templateId] });
      const response = await atCommit(
        target,
        async (db) => {
          await run(db, 'UPDATE scanners SET updated_at = updated_at + 1 WHERE id = ?', [
            scanner.id,
          ]);
        },
        () => request('POST', scannerPath(scanner.id, action), actor.session.headers),
      );
      expect(response.status).toBe(200);
    }, 60_000);
  }

  it('issues and redeems scanner credentials without requiring a template release', async () => {
    const actor = await member();
    const unapproved = await kit.scanTemplate(
      'Credential only',
      { actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }] },
      { releaseModes: [] },
    );
    const device = await kit.scanner({ mode: 'test', templateIds: [unapproved] });
    const testHeaders = { ...actor.session.headers, 'x-passbook-mode': 'test' };
    const issue = await request('POST', scannerPath(device.id, 'pairing'), testHeaders);
    expect(issue.status).toBe(200);
    const { code } = (await issue.json()) as { code: string };
    expect((await request('POST', '/scan/pair', {}, { code })).status).toBe(200);
    expect((await request('POST', scannerPath(device.id, 'pair-here'), testHeaders)).status).toBe(
      200,
    );
    const terminal = await kit.scanner({
      mode: 'test',
      kind: 'terminal',
      templateIds: [unapproved],
    });
    expect((await request('POST', scannerPath(terminal.id, 'token'), testHeaders)).status).toBe(
      200,
    );
  }, 60_000);

  for (const creation of ['scanner', 'setup', 'session device'] as const) {
    it(`does not issue a ${creation} pairing code after membership revocation`, async () => {
      const actor = await member();
      const name = `Pair race ${kit.fx.ids.token(6)}`;
      let path = creation === 'scanner' ? '/scanners' : '/scan-setups';
      let body: object = {
        orgId: kit.org.id,
        name,
        kind: 'device',
        timeZone: 'UTC',
        accepts: { templateIds: [templateId] },
      };
      if (creation === 'session device') {
        const session = await request('POST', '/scanning-sessions', actor.session.headers, {
          orgId: kit.org.id,
          name: `Session ${kit.fx.ids.token(6)}`,
          timeZone: 'UTC',
          accepts: { templateIds: [templateId] },
        });
        expect(session.status).toBe(201);
        const { id } = (await session.json()) as { id: string };
        path = `/scanning-sessions/${id}/devices`;
        body = { name, surface: 'phone' };
      }
      const response = await atCommit(
        'code',
        async (db) => {
          await run(db, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
            kit.clock.now(),
            actor.membershipId,
          ]);
        },
        () => request('POST', path, actor.session.headers, body),
      );
      expect([403, 409, 412]).toContain(response.status);
      const created = await first<{ id: string; pair_code_hash: string | null }>(
        kit.env.DB,
        'SELECT id, pair_code_hash FROM scanners WHERE org_id = ? AND name = ?',
        [kit.org.id, name],
      );
      if (created) {
        expect(created.pair_code_hash).toBeNull();
        expect(
          await all(
            kit.env.DB,
            "SELECT id FROM audit_log WHERE target_id = ? AND action = 'scanner.pairing_create'",
            [created.id],
          ),
        ).toEqual([]);
      }
    }, 60_000);
  }

  it('requires explicit manage membership even for a platform administrator', async () => {
    const reader = await member(['read_only']);
    const operator = await member(['pass_operator']);
    const user = await makeUser(kit.fx);
    const platform = await makeSession(kit.fx, { userId: user.id, roles: ['admin', 'user'] });
    const device = await kit.scanner({ mode: 'test', templateIds: [templateId] });
    const terminal = await kit.scanner({ kind: 'terminal' });
    const inTest = (headers: Record<string, string>) => ({ ...headers, 'x-passbook-mode': 'test' });
    expect(
      (await request('GET', scannerPath(device.id, 'pairing'), inTest(reader.session.headers)))
        .status,
    ).toBe(200);
    for (const headers of [reader.session.headers, operator.session.headers, platform.headers]) {
      for (const action of ['pairing', 'pair-here', 'sample-pass']) {
        expect(
          (await request('POST', scannerPath(device.id, action), inTest(headers))).status,
        ).toBe(403);
      }
      expect((await request('POST', scannerPath(terminal.id, 'token'), headers)).status).toBe(403);
    }
  });

  it('rejects mismatched users, tenants and capabilities in the services themselves', async () => {
    const actor = await member();
    const session = await createSessionStore(kit.env, kit.clock).resolve(actor.session.cookieValue);
    if (!session) throw new Error('Expected a real session.');
    const auth = { ...session, mode: 'test' as const };
    const manage = await tenantAuthorityOf(kit.ctx, auth, kit.org.id, 'scanning:manage');
    const read = await tenantAuthorityOf(kit.ctx, auth, kit.org.id, 'scanning:read');
    const operate = await tenantAuthorityOf(kit.ctx, auth, kit.org.id, 'passes:operate');
    const device = await kit.scanner({ mode: 'test', templateIds: [templateId] });
    const terminal = await kit.scanner({ mode: 'test', kind: 'terminal' });
    const row = await getConsoleScanner(kit.env.DB, device.id);
    const till = await getConsoleScanner(kit.env.DB, terminal.id);
    if (!row || !till) throw new Error('Expected scanner fixtures.');
    const beforeDevice = await scannerState(device.id);
    const beforeTerminal = await scannerState(terminal.id);
    const beforePass = await passState();
    await expect(createPairing(kit.ctx, 'another-user', row, ORIGIN, manage)).rejects.toMatchObject(
      { code: 'FORBIDDEN' },
    );
    await expect(
      createPairing(kit.ctx, actor.user.id, { ...row, orgId: 'another-org' }, ORIGIN, manage),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(pairHere(kit.ctx, actor.user.id, row, undefined, read)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(replaceTerminalToken(kit.ctx, 'another-user', till, manage)).rejects.toMatchObject(
      { code: 'FORBIDDEN' },
    );
    await expect(
      createSamplePass(kit.ctx, actor.user.id, device.id, read, operate),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await scannerState(device.id)).toEqual(beforeDevice);
    expect(await scannerState(terminal.id)).toEqual(beforeTerminal);
    expect(await passState()).toEqual(beforePass);
  }, 60_000);

  it('preserves issued code redemption and valid device and terminal token rotation', async () => {
    const issuer = await member();
    const device = await kit.scanner({ templateIds: [templateId] });
    const response = await request(
      'POST',
      scannerPath(device.id, 'pairing'),
      issuer.session.headers,
    );
    expect(response.status).toBe(200);
    const { code } = (await response.json()) as { code: string };
    await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
      kit.clock.now(),
      issuer.membershipId,
    ]);
    const paired = await request('POST', '/scan/pair', {}, { code });
    expect(paired.status).toBe(200);
    const firstCookie = paired.headers.get('set-cookie') ?? '';
    const firstToken = /__Host-wallet_scan=([^;]+)/.exec(firstCookie)?.[1] ?? '';
    const store = createScannerStore(kit.env, kit.clock);
    expect((await store.resolve(firstToken, 'cookie'))?.scannerId).toBe(device.id);
    const actor = await member();
    const here = await request('POST', scannerPath(device.id, 'pair-here'), actor.session.headers);
    expect(here.status).toBe(200);
    expect(await store.resolve(firstToken, 'cookie')).toBeNull();
    const hereToken =
      /__Host-wallet_scan=([^;]+)/.exec(here.headers.get('set-cookie') ?? '')?.[1] ?? '';
    expect((await store.resolve(hereToken, 'cookie'))?.scannerId).toBe(device.id);
    const terminal = await kit.scanner({ kind: 'terminal' });
    const first = await request('POST', scannerPath(terminal.id, 'token'), actor.session.headers);
    expect(first.status).toBe(200);
    const token1 = ((await first.json()) as { token: string }).token;
    const second = await request('POST', scannerPath(terminal.id, 'token'), actor.session.headers);
    expect(second.status).toBe(200);
    const token2 = ((await second.json()) as { token: string }).token;
    expect(token2).not.toBe(token1);
    expect(await store.resolve(token1, 'bearer')).toBeNull();
    expect((await store.resolve(token2, 'bearer'))?.scannerId).toBe(terminal.id);
  }, 60_000);
});
