import { describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { act } from './act.ts';
import { scannerActor, withRole } from './actor.ts';
import { publishScan } from './live.ts';
import { getScanner } from './repo-device.ts';
import { candidateById } from './repo-lookup.ts';
import { registerHubLoggingTests } from './scan-hub-logging-test-fixtures.ts';
import { hub, kit, screen, template } from './scan-hub-test-fixtures.ts';
import { codeOf, key, proofedScanActor } from './test-kit.ts';

describe('live display hub', () => {
  registerHubLoggingTests();

  it('publishes the public holder title and redacts references to another mode', async () => {
    const source = await kit.scanner({ templateIds: [template] });
    const monitor = await screen('monitor', [source.id]);
    const device = await getScanner(kit.env.DB, source.id);
    if (!device) throw new Error('Source fixture is missing.');
    const actor = await proofedScanActor(
      kit.ctx,
      withRole(
        scannerActor(kit.ctx, device, 'live', 'cookie', { event: null, templateIds: [template] }),
        null,
      ),
    );
    const pass = await kit.scanPass(template, { memberName: 'Public Member' });
    const { outcome, evaluatedSnapshot, credentialContext } = await act(kit.ctx, actor, {
      input: codeOf(pass),
      actionId: 'auto',
      clientTs: kit.clock.now(),
      idempotencyKey: key(),
    });
    if (!outcome.display) throw new Error('The result fixture has no display.');
    outcome.display.identity.holder = 'STAFF-ONLY-TITLE';
    publishScan(kit.ctx, actor, outcome, evaluatedSnapshot, credentialContext, 'camera');
    await kit.settle();
    expect((await hub().snapshot(monitor.attachment)).rows).toMatchObject([
      { holder: 'Public Member' },
    ]);
    const testPass = await kit.scanPass(
      template,
      { memberName: 'OTHER-MODE-TITLE' },
      { mode: 'test' },
    );
    const {
      outcome: refused,
      evaluatedSnapshot: refusedSnapshot,
      credentialContext: refusedContext,
    } = await act(kit.ctx, actor, {
      input: codeOf(testPass),
      actionId: 'auto',
      clientTs: kit.clock.now(),
      idempotencyKey: key(),
    });
    publishScan(kit.ctx, actor, refused, refusedSnapshot, refusedContext, 'camera');
    await kit.settle();
    const rows = (await hub().snapshot(monitor.attachment)).rows;
    expect(rows).toHaveLength(2);
    const accepted = rows.find((entry) => entry.holder === 'Public Member');
    const redacted = rows.find((entry) => entry.holder === null);
    expect(accepted?.id).toBeTruthy();
    expect(accepted?.id).not.toBe(outcome.scanId);
    expect(redacted).toMatchObject({ holder: null, passId: null });
    expect(redacted?.id).not.toBe(refused.scanId);
    expect(JSON.stringify(rows)).not.toMatch(/STAFF-ONLY-TITLE|OTHER-MODE-TITLE/);
  });

  it('withholds an outcome whose card is not the evaluated pass, and publishes the matching one', async () => {
    const source = await kit.scanner({ templateIds: [template] });
    const monitor = await screen('monitor', [source.id]);
    const device = await getScanner(kit.env.DB, source.id);
    if (!device) throw new Error('Missing source scanner.');
    const actor = await proofedScanActor(
      kit.ctx,
      withRole(
        scannerActor(kit.ctx, device, 'live', 'cookie', { event: null, templateIds: [template] }),
        null,
      ),
    );
    const pass = await kit.scanPass(template);
    const other = await kit.scanPass(template);
    const { outcome, evaluatedSnapshot, credentialContext } = await act(kit.ctx, actor, {
      input: codeOf(pass),
      actionId: 'auto',
      clientTs: kit.clock.now(),
      idempotencyKey: key(),
    });
    if (!evaluatedSnapshot) throw new Error('Missing evaluated pass.');
    const swapped = { ...outcome, card: { ...outcome.card, passId: other.id } as never };
    publishScan(kit.ctx, actor, swapped, evaluatedSnapshot, credentialContext, 'camera');
    await kit.settle();
    expect((await hub().snapshot(monitor.attachment)).rows).toEqual([]);

    publishScan(kit.ctx, actor, outcome, evaluatedSnapshot, credentialContext, 'camera');
    await kit.settle();
    const rows = (await hub().snapshot(monitor.attachment)).rows;
    expect(rows).toMatchObject([{ passId: pass.id, holder: 'Anna Popescu' }]);
    const stored = await hub().ringRow(rows[0]?.id ?? '');
    expect(stored).toMatchObject({
      scanId: outcome.scanId,
      templateId: template,
      gen: {
        credential: evaluatedSnapshot.pass.credentialGeneration,
        lifecycle: evaluatedSnapshot.pass.lifecycleGeneration,
      },
    });
    for (const privateValue of [
      credentialContext?.credentialKeysetCommitment ?? 'none',
      ...(credentialContext?.credentialTombstoneRefs ?? []),
      ...(credentialContext?.otherModeCredentialTombstoneRefs ?? []),
    ]) {
      expect(JSON.stringify(rows)).not.toContain(privateValue);
      expect(JSON.stringify(stored)).not.toContain(privateValue);
    }
  });

  it.each(['wallet document', 'wallet serial', 'pass personalization'] as const)(
    'keeps the evaluated pass on its screen after a content-only %s change',
    async (changed) => {
      const source = await kit.scanner({ templateIds: [template] });
      const monitor = await screen('monitor', [source.id]);
      const device = await getScanner(kit.env.DB, source.id);
      if (!device) throw new Error('Missing source scanner.');
      const actor = await proofedScanActor(
        kit.ctx,
        withRole(
          scannerActor(kit.ctx, device, 'live', 'cookie', { event: null, templateIds: [template] }),
          null,
        ),
      );
      const pass = await kit.scanPass(template, { memberName: 'Original Wallet Member' });
      const png = btoa(String.fromCharCode(...makePng(270, 270)));
      await putMemberPhoto(
        kit.ctx,
        { type: 'system', id: null },
        pass.id,
        { png, includeInPass: false },
        null,
      );
      const now = kit.clock.now();
      const { outcome, evaluatedSnapshot, credentialContext } = await act(kit.ctx, actor, {
        input: codeOf(pass),
        actionId: 'check_in',
        clientTs: now,
        idempotencyKey: key(),
      });
      expect(outcome.kind).toBe('ok');
      if (!evaluatedSnapshot?.passJsonSnapshot || evaluatedSnapshot.walletVersion === null)
        throw new Error('Missing evaluated Wallet document.');
      if (changed !== 'pass personalization') {
        const field = changed === 'wallet serial' ? '$.serialNumber' : '$.organizationName';
        const updated = await run(
          kit.env.DB,
          `UPDATE pass_versions SET pass_json = json_set(pass_json, ?, ?)
          WHERE pass_id = ? AND version = ?`,
          [field, 'Altered value', pass.id, evaluatedSnapshot.walletVersion],
        );
        expect(updated.changes).toBe(1);
      } else {
        await run(
          kit.env.DB,
          "UPDATE passes SET personalization = json_set(personalization, '$.memberName', ?) WHERE id = ?",
          ['Changed Member', pass.id],
        );
      }
      const current = await candidateById(kit.env.DB, kit.org.id, pass.id);
      if (!current) throw new Error('Missing current pass.');
      expect(current.pass.version).toBe(evaluatedSnapshot.pass.version);
      if (changed !== 'pass personalization')
        expect(current.passJsonSnapshot).not.toBe(evaluatedSnapshot.passJsonSnapshot);
      else expect(current.pass.personalization).not.toEqual(evaluatedSnapshot.pass.personalization);
      expect(kit.clock.now()).toBe(now);
      publishScan(kit.ctx, actor, outcome, evaluatedSnapshot, credentialContext, 'camera');
      await kit.settle();
      const projection = (await hub().snapshot(monitor.attachment)).rows.find(
        (entry) => entry.scannerId === source.id,
      );
      if (!projection) throw new Error('Missing retained event.');
      // Content is not authority (F8): the row is the one the source screen showed.
      expect(projection).toMatchObject({ passId: pass.id, holder: 'Original Wallet Member' });
      expect(projection.photoUrl).toEqual(expect.any(String));
    },
  );

  it.each(['organization', 'template'] as const)(
    "shows an evaluated outcome after a same-clock %s change that left the recipient's authority intact",
    async (changed) => {
      const id = await kit.scanTemplate(`Outcome ${changed} ABA`, {
        actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
      });
      const source = await kit.scanner({ templateIds: [id] });
      const monitor = await screen('monitor', [source.id]);
      const device = await getScanner(kit.env.DB, source.id);
      if (!device) throw new Error('Missing source scanner.');
      const actor = await proofedScanActor(
        kit.ctx,
        withRole(
          scannerActor(kit.ctx, device, 'live', 'cookie', { event: null, templateIds: [id] }),
          null,
        ),
      );
      const pass = await kit.scanPass(id, { memberName: 'ABA Private Member' });
      const png = btoa(String.fromCharCode(...makePng(270, 270)));
      await putMemberPhoto(
        kit.ctx,
        { type: 'system', id: null },
        pass.id,
        { png, includeInPass: false },
        null,
      );
      const now = kit.clock.now();
      const { outcome, evaluatedSnapshot, credentialContext } = await act(kit.ctx, actor, {
        input: codeOf(pass),
        actionId: 'check_in',
        clientTs: now,
        idempotencyKey: key(),
      });
      expect(outcome.kind).toBe('ok');
      const named = await first<{ name: string }>(
        kit.env.DB,
        'SELECT name FROM orgs WHERE id = ?',
        [kit.org.id],
      );
      if (!named) throw new Error('Missing organization.');
      const [column, away, back] =
        changed === 'organization'
          ? ['status', 'suspended', 'active']
          : ['name', `${named.name} (away)`, named.name];
      for (const value of [away, back])
        await run(kit.env.DB, `UPDATE orgs SET ${column} = ? WHERE id = ?`, [value, kit.org.id]);
      publishScan(kit.ctx, actor, outcome, evaluatedSnapshot, credentialContext, 'camera');
      await kit.settle();
      const projection = (await hub().snapshot(monitor.attachment)).rows.find(
        (entry) => entry.scannerId === source.id,
      );
      expect(projection).toMatchObject({ passId: pass.id, photoUrl: expect.any(String) });
      expect(JSON.stringify(projection)).not.toMatch(
        /sourceProof|passSnapshot|passCommitment|credentialTombstoneRefs|walletVersion|versionPersonalization|orgRevision|templateRevision|identityRevision|activeRelease|passReleaseId/,
      );
    },
  );
});
