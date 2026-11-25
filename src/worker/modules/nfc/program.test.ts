import { beforeAll, describe, expect, it, vi } from 'vitest';
import { all, first } from '../../platform/db.ts';
import { countingRandom } from './ntag424/sim/fixtures.ts';
import { Ntag424Sim } from './ntag424/sim/tag.ts';
import { type ProgramFixture, programFixture } from './program-test-fixtures.ts';
import { bytesToHex, verifySun } from './sun.ts';
import { parseSunUrl } from './sun-url.ts';
import { tagRef } from './tag-ref.ts';

// NXP's key signs real tags; the simulator signs with its own. The real key is exercised in program-nxp.test.ts.
vi.mock('./ntag424/originality.ts', () => import('./program-originality-test-fixtures.ts'));

let f: ProgramFixture;
beforeAll(async () => {
  f = await programFixture();
});
const db = () => f.kit.env.DB;
const programs = (orgId = f.o.org.id) =>
  all<Record<string, unknown>>(db(), 'SELECT * FROM nfc_tag_programs WHERE org_id = ?', [orgId]);

describe('programming a blank tag through the service', () => {
  it('keys the tag, makes it a Secure tag with its admin keys, and ends the row with nothing sealed', async () => {
    const sim = new Ntag424Sim({ random: countingRandom() });
    const a = await f.authority();
    const { url, holds } = await f.finish(sim, f.port(a));
    expect(holds).toBe(1);
    const tap = parseSunUrl(url);
    expect(tap).toMatchObject({ slug: f.keyset.slug });

    // The tag holds the keys the database holds: K1 is the keyset's meta key, the rest are the tag's own.
    expect(sim.tag.keys.every((k) => bytesToHex(k) !== '00'.repeat(16))).toBe(true);
    expect(sim.tag.versions).toEqual([1, 1, 1, 1, 1]);
    const stored = await f.expectKeysMatch(sim);
    expect(stored?.ctr).toBe(1);
    const uid = bytesToHex(sim.tag.uid);
    const { ref, hint } = await tagRef(f.kit.env, f.o.org.id, 'live', uid);
    const tag = await first<{ id: string; system: string; hint: string }>(
      db(),
      'SELECT id, system, hint FROM nfc_tags WHERE org_id = ? AND tag_ref = ?',
      [f.o.org.id, ref],
    );
    expect(tag).toMatchObject({ id: stored?.tagId, system: 'sun', hint });

    // The read-back verifies with the keys that were written.
    const read = await verifySun(
      { metaKey: f.keyset.meta, fileKey: sim.tag.keys[2] as Uint8Array, diversified: false },
      (tap as { p: string }).p,
      (tap as { m: string }).m,
    );
    expect(read).toMatchObject({ ok: true, read: { uid } });

    // The row ends: no intended keys, no session, the tag it made; and no UID anywhere in it.
    const [row] = await programs();
    expect(row).toMatchObject({
      state: 'programmed',
      step: 'done',
      kek_version: null,
      sess_kek_version: null,
      tag_id: tag?.id,
    });
    expect(JSON.stringify(await programs())).not.toContain(uid);
    const actions = await all<{ action: string }>(
      db(),
      "SELECT action FROM audit_log WHERE org_id = ? AND action LIKE 'nfc_tag.program%' ORDER BY id",
      [f.o.org.id],
    );
    expect(actions.map((x) => x.action).sort()).toEqual([
      'nfc_tag.program_started',
      'nfc_tag.programmed',
    ]);
  });
});
