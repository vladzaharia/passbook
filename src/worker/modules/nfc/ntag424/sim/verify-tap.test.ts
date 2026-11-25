import { beforeAll, describe, expect, it } from 'vitest';
import { loadKekRing } from '../../../../platform/crypto.ts';
import { run } from '../../../../platform/db.ts';
import { sunKeyset } from '../../../scan/sun-test-fixtures.ts';
import { type EnrollFixture, enrollFixture } from '../../../scan/tags-enroll-test-fixtures.ts';
import { sealTagKey } from '../../keyset-seal.ts';
import { sunStoredByRef } from '../../repo-sun.ts';
import { bytesToHex } from '../../sun.ts';
import { sunStale, verifySunTap } from '../../systems/sun.ts';
import { tagRef } from '../../tag-ref.ts';
import { countingRandom, testPlan } from './fixtures.ts';
import { programTag, readUrl } from './program.ts';
import { RelayServer } from './relay-server.ts';
import { Ntag424Sim } from './tag.ts';

let f: EnrollFixture;
beforeAll(async () => {
  f = await enrollFixture();
});

const read = (url: string) => ({
  tech: 'isodep' as const,
  source: 'native' as const,
  ndef: { type: 'U' as const, value: url },
});

describe('a programmed simulated tag, tapped at the existing verifier', () => {
  it('verifySunTap accepts its taps, with its own file key, and the read-back counter is its stored one', async () => {
    const { kit } = f;
    const plan = testPlan();
    const ks = await sunKeyset(kit, kit.org.id, {
      perTag: true,
      meta: plan.keys[1],
      file: plan.keys[3],
    });
    plan.slug = ks.slug;
    plan.version = 1;
    const sim = new Ntag424Sim({ random: countingRandom() });
    const send = (apdu: Uint8Array) => sim.transceive(apdu);
    const readback = await programTag(send, new RelayServer(plan));

    // What programming commits: the tag, and its own file key (K2) sealed under the keyset.
    const uid = bytesToHex(sim.tag.uid);
    const { ref, hint } = await tagRef(kit.env, kit.org.id, 'live', uid);
    await run(
      kit.env.DB,
      "INSERT INTO nfc_tags (id, org_id, mode, tag_ref, system, hint, created_at) VALUES ('sim-1', ?, 'live', ?, 'sun', ?, 1)",
      [kit.org.id, ref, hint],
    );
    const e = await sealTagKey(
      await loadKekRing(kit.env),
      { orgId: kit.org.id, mode: 'live', keysetId: ks.id },
      'sim-1',
      plan.keys[2] as Uint8Array,
    );
    await run(
      kit.env.DB,
      `INSERT INTO nfc_tag_sun (tag_id, keyset_id, key_version, kek_version, iv, wrapped_dek, ciphertext, ctr, ctr_at)
       VALUES ('sim-1', ?, 1, ?, ?, ?, ?, 1, 1)`,
      [ks.id, e.kekVersion, e.iv, e.wrappedDek, e.ciphertext],
    );

    const tap = await verifySunTap(kit.ctx, kit.org.id, 'live', read(await readUrl(send)));
    expect(tap).toMatchObject({
      ok: true,
      proof: { ref, hint, keyVersion: 1, ctr: 2, slug: ks.slug },
    });
    const stored = await sunStoredByRef(kit.env.DB, kit.org.id, 'live', ref);
    if (!tap.ok) throw new Error('unreachable');
    expect(sunStale(kit.ctx, kit.org.id, tap.proof, stored)).toBeNull();

    // The read-back itself used counter 1: replaying it is stale.
    const replay = await verifySunTap(kit.ctx, kit.org.id, 'live', read(readback));
    if (!replay.ok) throw new Error('read-back must verify');
    expect(replay.proof.ctr).toBe(1);
    expect(sunStale(kit.ctx, kit.org.id, replay.proof, stored)).toBe('TAG_SUN_REPLAY');
  });

  it('a tag programmed with a file key the server does not hold is refused', async () => {
    const { kit } = f;
    const plan = testPlan();
    const ks = await sunKeyset(kit, kit.org.id, {
      perTag: true,
      meta: plan.keys[1],
      file: plan.keys[3],
    });
    plan.slug = ks.slug;
    const sim = new Ntag424Sim({
      uid: new Uint8Array([4, 1, 2, 3, 4, 5, 6]),
      random: countingRandom(),
    });
    const send = (apdu: Uint8Array) => sim.transceive(apdu);
    await programTag(send, new RelayServer(plan));
    const tap = await verifySunTap(kit.ctx, kit.org.id, 'live', read(await readUrl(send)));
    expect(tap).toMatchObject({ ok: false, code: 'TAG_SUN_VERIFY' });
  });
});
