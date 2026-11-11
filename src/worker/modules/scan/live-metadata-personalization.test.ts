import { describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { updatePass } from '../passes/service.ts';
import { livePassCommitmentValid } from './live-pass-commitment.ts';
import { openLiveSourceProof } from './live-provenance.ts';
import { candidateById } from './repo-lookup.ts';
import { hub, kit, photoFixture, publish, row } from './scan-hub-test-fixtures.ts';

describe('live metadata-only pass personalization', () => {
  it.each(['[]', 'null', '"legacy"', '42'] as const)(
    'accepts the legacy Wallet-row personalization bytes %s and fences later byte changes',
    async (raw) => {
      const fixture = await photoFixture();
      const before = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
      if (!before || before.walletVersion === null) throw new Error('Missing Wallet row.');
      await run(
        kit.env.DB,
        'UPDATE pass_versions SET personalization = ? WHERE pass_id = ? AND version = ?',
        [raw, fixture.pass.id, before.walletVersion],
      );
      expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(404);
      const event = row(fixture.source.id, { passId: fixture.pass.id });
      await publish(event);
      const fresh = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
        (entry) => entry.id === event.id,
      );
      if (!fresh?.photoUrl) throw new Error('Missing legacy Wallet-row photo.');
      expect(fresh.passId).toBe(fixture.pass.id);
      const path = fresh.photoUrl.replace('/api/v1/scan', '');
      expect((await kit.get(fixture.monitor.headers, path)).status).toBe(200);
      const candidate = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
      const sealed = await hub().sourceProof(event.id);
      if (!candidate || !sealed) throw new Error('Missing legacy Wallet commitment.');
      expect(candidate.versionPersonalization).toBe(raw);
      const proof = await openLiveSourceProof(kit.env, sealed);
      expect(proof?.passSnapshot).not.toHaveProperty('versionPersonalization');
      expect(
        await livePassCommitmentValid(
          kit.env,
          candidate,
          proof?.passSnapshot?.passCommitment ?? null,
        ),
      ).toBe(true);
      await run(
        kit.env.DB,
        'UPDATE pass_versions SET personalization = ? WHERE pass_id = ? AND version = ?',
        [`${raw} `, fixture.pass.id, candidate.walletVersion],
      );
      expect((await kit.get(fixture.monitor.headers, path)).status).toBe(404);
      const stale = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
        (entry) => entry.id === event.id,
      );
      expect(stale).toMatchObject({ passId: null, holder: null, photoUrl: null });
    },
  );

  it('fences changes to the opaque Wallet-row template version', async () => {
    const fixture = await photoFixture();
    const before = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
    if (!before || before.walletVersion === null) throw new Error('Missing Wallet row.');
    await run(
      kit.env.DB,
      'UPDATE pass_versions SET template_version = ? WHERE pass_id = ? AND version = ?',
      ['different-wallet-version', fixture.pass.id, before.walletVersion],
    );
    expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(404);
    const event = row(fixture.source.id, { passId: fixture.pass.id });
    await publish(event);
    const fresh = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (entry) => entry.id === event.id,
    );
    if (!fresh?.photoUrl) throw new Error('Missing opaque Wallet-version photo.');
    const path = fresh.photoUrl.replace('/api/v1/scan', '');
    expect((await kit.get(fixture.monitor.headers, path)).status).toBe(200);
    const sealed = await hub().sourceProof(event.id);
    if (!sealed) throw new Error('Missing Wallet-version proof.');
    expect((await openLiveSourceProof(kit.env, sealed))?.passSnapshot?.walletTemplateVersion).toBe(
      'different-wallet-version',
    );
    await run(
      kit.env.DB,
      'UPDATE pass_versions SET template_version = ? WHERE pass_id = ? AND version = ?',
      ['later-wallet-version', fixture.pass.id, before.walletVersion],
    );
    expect((await kit.get(fixture.monitor.headers, path)).status).toBe(404);
    const stale = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (entry) => entry.id === event.id,
    );
    expect(stale).toMatchObject({ passId: null, holder: null, photoUrl: null });
  });

  it('commits the current pass and the older Wallet row independently', async () => {
    const fixture = await photoFixture();
    const before = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
    if (
      !before?.passJsonSnapshot ||
      !before.versionPersonalization ||
      before.walletVersion === null
    )
      throw new Error('Missing original Wallet provenance.');
    expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(200);

    await updatePass(
      jobCtxOf(kit),
      { type: 'system', id: null },
      fixture.pass.id,
      { input: { memberNo: 'METADATA-ONLY-123' } },
      { scope: null },
    );
    const candidate = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
    if (
      !candidate?.passJsonSnapshot ||
      !candidate.versionPersonalization ||
      candidate.walletVersion === null
    )
      throw new Error('Missing metadata-only Wallet provenance.');
    expect(candidate.pass.version).toBeGreaterThan(before.pass.version);
    expect(candidate.pass.objectKey).toBe(before.pass.objectKey);
    expect(candidate.passJsonSnapshot).toBe(before.passJsonSnapshot);
    expect(candidate.walletVersion).toBe(before.walletVersion);
    expect(candidate.versionPersonalization).toBe(before.versionPersonalization);
    expect(candidate.pass.personalization.memberNo).toBe('METADATA-ONLY-123');
    expect(JSON.parse(candidate.versionPersonalization)).not.toEqual(
      candidate.pass.personalization,
    );
    expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(404);
    const stale = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (entry) => entry.id === fixture.event.id,
    );
    expect(stale).toMatchObject({ passId: null, holder: null, photoUrl: null });

    const event = row(fixture.source.id, { passId: fixture.pass.id });
    await publish(event);
    const fresh = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (entry) => entry.id === event.id,
    );
    if (!fresh?.photoUrl) throw new Error('Missing metadata-only live photo.');
    expect(fresh.passId).toBe(fixture.pass.id);
    const path = fresh.photoUrl.replace('/api/v1/scan', '');
    expect((await kit.get(fixture.monitor.headers, path)).status).toBe(200);
    const sealed = await hub().sourceProof(event.id);
    if (!sealed) throw new Error('Missing metadata-only source proof.');
    const proof = await openLiveSourceProof(kit.env, sealed);
    const commitment = proof?.passSnapshot?.passCommitment;
    if (!commitment) throw new Error('Missing metadata-only pass commitment.');
    expect(proof!.passSnapshot!.walletVersion).toBe(candidate.walletVersion);
    expect(JSON.stringify(proof!.passSnapshot)).not.toContain(candidate.versionPersonalization);
    expect(JSON.stringify(proof!.passSnapshot)).not.toContain('METADATA-ONLY-123');
    expect(await livePassCommitmentValid(kit.env, candidate, commitment)).toBe(true);

    const changedPass = structuredClone(candidate);
    changedPass.pass.personalization.memberNo = 'ALTERED-PASS';
    expect(await livePassCommitmentValid(kit.env, changedPass, commitment)).toBe(false);
    const walletPersonalization = JSON.parse(candidate.versionPersonalization) as Record<
      string,
      unknown
    >;
    const changedWallet = {
      ...candidate,
      versionPersonalization: JSON.stringify({
        ...walletPersonalization,
        memberNo: 'ALTERED-WALLET',
      }),
    };
    expect(await livePassCommitmentValid(kit.env, changedWallet, commitment)).toBe(false);

    await run(
      kit.env.DB,
      `UPDATE pass_versions SET personalization = json_set(personalization, '$.memberNo', ?)
      WHERE pass_id = ? AND version = ?`,
      ['ALTERED-WALLET', fixture.pass.id, candidate.walletVersion],
    );
    expect((await kit.get(fixture.monitor.headers, path)).status).toBe(404);
    const altered = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (entry) => entry.id === event.id,
    );
    expect(altered).toMatchObject({ passId: null, holder: null, photoUrl: null });
  });
});
