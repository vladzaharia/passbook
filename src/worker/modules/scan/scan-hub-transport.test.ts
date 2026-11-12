import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { fromBase64Url } from '../../platform/ids.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { scanScannerCsrfProof } from './actor.ts';
import { openLiveAttachment, sealLiveAttachment } from './live-attachment.ts';
import { openLiveSourceProof } from './live-provenance.ts';
import { getScanner } from './repo-device.ts';
import { candidateById } from './repo-lookup.ts';
import {
  hub,
  kit,
  next,
  photoFixture,
  proven,
  publish,
  row,
  screen,
  template,
} from './scan-hub-test-fixtures.ts';

describe('live display transport and authorization', () => {
  it('filters monitor catch-up by watched scanners and deduplicates retries', async () => {
    const a = await kit.scanner({ templateIds: [template] });
    const b = await kit.scanner({ templateIds: [template] });
    const monitor = await screen('monitor', [a.id]);
    const body = row(a.id);
    await publish(body);
    await publish(body);
    await publish(row(b.id));
    expect((await hub().snapshot(monitor.attachment)).rows).toMatchObject([
      { scannerId: a.id, holder: null, passId: null },
    ]);
    expect((await hub().snapshot(monitor.attachment, body.id)).rows).toHaveLength(0);
  });

  it('rejects snapshots missing their captured actor or workspace observation', async () => {
    const source = await kit.scanner({ templateIds: [template] });
    const monitor = await screen('monitor', [source.id]);
    const event = row(source.id);
    expect(await publish(event)).toBe(true);
    expect((await hub().snapshot(monitor.attachment)).rows).toMatchObject([{ id: event.id }]);
    for (const field of ['actor', 'observation'] as const) {
      const missing = { ...monitor.attachment };
      Reflect.deleteProperty(missing, field);
      await expect(sealLiveAttachment(kit.env, missing)).rejects.toThrow();
      expect((await hub().snapshot(missing)).rows).toEqual([]);
    }
  });

  it('rejects a captured actor detached from its tenant, mode or scanner', async () => {
    const source = await kit.scanner({ templateIds: [template] });
    const monitor = await screen('monitor', [source.id]);
    const event = row(source.id);
    expect(await publish(event)).toBe(true);
    expect((await hub().snapshot(monitor.attachment)).rows).toMatchObject([{ id: event.id }]);
    const other = await makeOrg(kit.fx);
    const foreignScanner = await kit.scanner({ orgId: other.id });
    const { attachment } = monitor;
    const actor = attachment.actor;
    if (!actor.scanner) throw new Error('Missing captured screen scanner.');
    for (const altered of [
      { ...attachment, actor: { ...actor, orgId: other.id } },
      { ...attachment, actor: { ...actor, mode: 'test' as const } },
      { ...attachment, actor: { ...actor, scanner: { ...actor.scanner, id: foreignScanner.id } } },
    ]) {
      expect((await hub().snapshot(altered)).rows).toEqual([]);
    }
  });

  it('rejects unsealed or tampered upgrades and closes a socket with an unsealed hibernation attachment', async () => {
    const source = await kit.scanner({ templateIds: [template] });
    const monitor = await screen('monitor', [source.id]);
    const sealed = await sealLiveAttachment(kit.env, monitor.attachment);
    const index = Math.floor(sealed.length / 2);
    const tampered =
      sealed.slice(0, index) + (sealed[index] === 'A' ? 'B' : 'A') + sealed.slice(index + 1);
    for (const token of [JSON.stringify(monitor.attachment), 'v1.invalid', tampered]) {
      const response = await hub().fetch(
        new Request('https://hub.test', {
          headers: { upgrade: 'websocket', 'x-pb-live': token },
        }),
      );
      expect(response.status).toBe(401);
    }
    const response = await hub().fetch(
      new Request('https://hub.test', {
        headers: { upgrade: 'websocket', 'x-pb-live': sealed },
      }),
    );
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    await next(socket);
    try {
      await runInDurableObject(hub(), async (_object, state) => {
        const server = state.getWebSockets(monitor.id)[0];
        if (!server) throw new Error('Missing hibernating socket.');
        server.serializeAttachment(monitor.attachment);
      });
      const closed = Promise.withResolvers<number>();
      socket.addEventListener('close', (event) => closed.resolve(event.code), { once: true });
      expect(await publish(row(source.id))).toBe(true);
      expect(await closed.promise).toBe(4409);
    } finally {
      socket.close(1000);
    }
  });

  it('delivers a redacted customer verdict over a real hibernating WebSocket', async () => {
    const source = await kit.scanner({ templateIds: [template] });
    const customer = await screen('customer', [source.id]);
    const response = await hub().fetch(
      new Request('https://hub.test', {
        headers: {
          upgrade: 'websocket',
          'x-pb-live': await sealLiveAttachment(kit.env, customer.attachment),
        },
      }),
    );
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    await next(socket);
    try {
      const pass = await kit.scanPass(template);
      const received = next(socket);
      await publish(row(source.id, { passId: pass.id, kind: 'refused', label: 'Private reason' }));
      const verdict = await received;
      expect(verdict.rows).toMatchObject([
        { label: 'Please see the desk', holder: null, photoUrl: null, passId: null },
      ]);
      expect(JSON.stringify(verdict)).not.toMatch(/Private|Member|reason/);
      expect(JSON.stringify(verdict)).not.toContain('sourceProof');
      expect((await hub().snapshot(customer.attachment)).rows).toEqual([]);
      const closed = new Promise<number>((resolve) =>
        socket.addEventListener('close', (event) => resolve(event.code), { once: true }),
      );
      expect(await hub().kick(customer.id)).toBe(1);
      expect(await closed).toBe(4409);
    } finally {
      socket.close(1000);
    }
  });

  it('keeps encrypted source proofs out of monitor websocket snapshots, events and URLs', async () => {
    const fixture = await photoFixture();
    const source = await getScanner(kit.env.DB, fixture.source.id);
    if (!source?.csrfSecret || !source.tokenHash)
      throw new Error('Missing original scanner credentials.');
    const scannerSecret = source.csrfSecret;
    const scannerProof = await scanScannerCsrfProof(kit.env, source.id, scannerSecret);
    const monitorSecret = fixture.monitor.headers['x-csrf-token'];
    const monitorProof = fixture.monitor.attachment.scannerCsrfProof;
    if (!monitorSecret || !monitorProof) throw new Error('Missing monitor credential proof.');
    expect(fixture.monitor.attachment.actor.scanner).toMatchObject({
      id: fixture.monitor.id,
      csrfSecret: null,
    });
    expect(fixture.monitor.attachment.actor.scannerCsrfProof).toBe(monitorProof);
    expect(fixture.monitor.attachment.observation).toBeNull();
    expect(JSON.stringify(fixture.monitor.attachment)).not.toContain(monitorSecret);
    const sealedAttachment = await sealLiveAttachment(kit.env, fixture.monitor.attachment);
    expect(sealedAttachment).not.toContain(scannerSecret);
    expect(sealedAttachment).not.toContain(fixture.monitor.attachment.tokenHash);
    expect(sealedAttachment).not.toContain(monitorSecret);
    expect(sealedAttachment).not.toContain(monitorProof);
    const response = await hub().fetch(
      new Request('https://hub.test', {
        headers: {
          upgrade: 'websocket',
          'x-pb-live': sealedAttachment,
        },
      }),
    );
    expect(response.status).toBe(101);
    const hibernation = await runInDurableObject(hub(), async (_object, state) =>
      state.getWebSockets(fixture.monitor.id).map((socket) => socket.deserializeAttachment()),
    );
    expect(hibernation).toContain(sealedAttachment);
    expect(JSON.stringify(hibernation)).not.toContain(scannerSecret);
    expect(JSON.stringify(hibernation)).not.toContain(fixture.monitor.attachment.tokenHash);
    expect(JSON.stringify(hibernation)).not.toContain(monitorSecret);
    expect(JSON.stringify(hibernation)).not.toContain(monitorProof);
    expect(await openLiveAttachment(kit.env, sealedAttachment)).toEqual(fixture.monitor.attachment);
    const socket = response.webSocket!;
    socket.accept();
    try {
      const initial = await next(socket);
      const originalProof = await hub().sourceProof(fixture.event.id);
      if (!originalProof) throw new Error('Missing source proof.');
      const opened = await openLiveSourceProof(kit.env, originalProof);
      if (!opened?.actor.scanner?.tokenHash) throw new Error('Missing private source lineage.');
      expect(opened.actor.scanner.csrfSecret).toBeNull();
      expect(opened.actor.scannerCsrfProof).toBe(scannerProof);
      expect(scannerProof).not.toBe(
        await scanScannerCsrfProof(kit.env, 'another-scanner', scannerSecret),
      );
      expect(JSON.stringify(opened)).not.toContain(scannerSecret);
      if (!opened.passSnapshot) throw new Error('Missing pass commitment.');
      const passSnapshot = JSON.stringify(opened.passSnapshot);
      for (const secret of [
        fixture.pass.serial,
        fixture.pass.downloadToken,
        fixture.pass.authToken,
        fixture.pass.scanCode,
      ]) {
        if (secret) expect(passSnapshot).not.toContain(secret);
      }
      const candidate = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
      if (!candidate?.passJsonSnapshot) throw new Error('Missing Wallet snapshot.');
      expect(opened.passSnapshot.identityRevision).toBe(candidate.identityRevision);
      expect(opened.passSnapshot.imageGeneration).toBe(candidate.pass.imageGeneration);
      expect(passSnapshot).not.toContain(candidate.passJsonSnapshot);
      const publicFields = [
        'id',
        'at',
        'scannerId',
        'scannerName',
        'passId',
        'holder',
        'photoUrl',
        'kind',
        'direction',
        'label',
        'presented',
      ].sort();
      expect(initial.rows).toHaveLength(1);
      expect(Object.keys(initial.rows[0]!).sort()).toEqual(publicFields);
      expect(JSON.stringify(initial)).not.toMatch(
        /sourceProof|platformSessionId|tokenHash|csrfSecret|scannerCsrfProof|sessionCsrfProof|passSnapshot|passCommitment|credentialKeysetCommitment|credentialTombstoneRefs|otherModeCredentialTombstoneRefs|walletVersion|versionPersonalization|imageGeneration|linkGeneration|connectionGeneration|identityRevision|activeTemplateVersion|activeRelease|passReleaseId/,
      );
      expect(JSON.stringify(initial)).not.toContain(opened.actor.scanner.tokenHash);
      expect(JSON.stringify(initial)).not.toContain(scannerSecret);
      expect(JSON.stringify(initial)).not.toContain(scannerProof);
      expect(JSON.stringify(initial)).not.toContain(monitorSecret);
      expect(JSON.stringify(initial)).not.toContain(monitorProof);
      expect(JSON.stringify(initial)).not.toContain(originalProof);
      const received = next(socket);
      const entry = row(fixture.source.id, { passId: fixture.pass.id });
      await publish(entry);
      const event = await received;
      const proof = await hub().sourceProof(entry.id);
      if (!proof || !event.rows[0]?.photoUrl) throw new Error('Missing live photo event.');
      expect(Object.keys(event.rows[0]).sort()).toEqual(publicFields);
      const body = JSON.stringify(event);
      expect(body).not.toMatch(
        /sourceProof|platformSessionId|tokenHash|csrfSecret|scannerCsrfProof|sessionCsrfProof|passSnapshot|passCommitment|credentialKeysetCommitment|credentialTombstoneRefs|otherModeCredentialTombstoneRefs|walletVersion|versionPersonalization|imageGeneration|linkGeneration|connectionGeneration|identityRevision|activeTemplateVersion|activeRelease|passReleaseId/,
      );
      expect(body).not.toContain(opened.actor.scanner.tokenHash);
      expect(body).not.toContain(scannerSecret);
      expect(body).not.toContain(scannerProof);
      expect(body).not.toContain(monitorSecret);
      expect(body).not.toContain(monitorProof);
      expect(body).not.toContain(proof);
      const url = new URL(event.rows[0].photoUrl, 'https://wallet.test');
      expect(url.searchParams.get('event')).toBe(entry.id);
      expect([...url.searchParams.keys()].sort()).toEqual(['event', 'g']);
      const grant = url.searchParams.get('g');
      if (!grant) throw new Error('Missing live grant.');
      expect(fromBase64Url(grant)).toHaveLength(40);
      expect(url.toString()).not.toContain(fixture.source.id);
      expect(url.toString()).not.toContain(opened.actor.scanner.tokenHash);
      expect(url.toString()).not.toContain(scannerSecret);
      expect(url.toString()).not.toContain(scannerProof);
      expect(url.toString()).not.toContain(monitorSecret);
      expect(url.toString()).not.toContain(monitorProof);
      expect(url.toString()).not.toContain(proof);
    } finally {
      socket.close(1000);
    }
  });

  it('never replays customer results and omits manual lookups', async () => {
    const source = await kit.scanner({ templateIds: [template] });
    const customer = await screen('customer', [source.id]);
    await publish(row(source.id, { presented: false }));
    expect((await hub().snapshot(customer.attachment)).rows).toEqual([]);
  });

  it('renders a permitted member photo with a monitor-bound grant', async () => {
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
    await publish(row(source.id, { passId: pass.id }));
    const snapshot = await hub().snapshot(monitor.attachment);
    const url = snapshot.rows[0]?.photoUrl ?? '';
    expect(url).toContain('/scan/live/passes/');
    const image = await kit.get(monitor.headers, url.replace('/api/v1/scan', ''));
    expect(image.status).toBe(200);
    const other = await screen('monitor', [source.id]);
    expect((await kit.get(other.headers, url.replace('/api/v1/scan', ''))).status).toBe(404);
  });

  it('rejects stale credentials and settings revisions before returning history', async () => {
    const source = await kit.scanner({ templateIds: [template] });
    const monitor = await screen('monitor', [source.id]);
    await publish(row(source.id));
    for (const patch of [{ tokenHash: 'wrong' }, { revision: -1 }, { expiresAt: 1 }])
      expect((await hub().snapshot({ ...monitor.attachment, ...patch })).rows).toHaveLength(0);
  });

  it('refuses tenant, mode and source mismatches at the object boundary', async () => {
    const source = await kit.scanner({ templateIds: [template] });
    const other = await makeOrg(kit.fx);
    await publish(row(source.id));
    const unproven = row(source.id);
    await expect(
      hub().publish({ orgId: kit.org.id, mode: 'live', row: { ...unproven, sourceProof: '' } }),
    ).resolves.toBe(false);
    await expect(
      hub().publish({ orgId: other.id, mode: 'live', row: await proven(row(source.id)) }),
    ).resolves.toBe(false);
    await expect(
      hub().publish({ orgId: kit.org.id, mode: 'test', row: await proven(row(source.id)) }),
    ).resolves.toBe(false);
    const foreign = await kit.scanner({ orgId: other.id });
    await expect(publish(row(foreign.id))).resolves.toBe(false);
  });
});
