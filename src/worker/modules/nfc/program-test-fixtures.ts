import { expect } from 'vitest';
import { TagProgramResultSchema } from '../../../shared/contracts/nfc-tag-programs.ts';
import { loadKekRing } from '../../platform/crypto.ts';
import { all, first, run } from '../../platform/db.ts';
import { capabilityChecks, tenantPrincipal } from '../passes/repo-authority.ts';
import { sunKeyset } from '../scan/sun-test-fixtures.ts';
import { openTagKey } from './keyset-seal.ts';
import { programTag, type RelayPort, type Send } from './ntag424/sim/program.ts';
import { TagLostError } from './ntag424/sim/state.ts';
import type { Ntag424Sim } from './ntag424/sim/tag.ts';
import { startProgram } from './program.ts';
import { authProgram } from './program-auth.ts';
import { resultProgram } from './program-commit.ts';
import { abortProgram, probeProgram, reauthProgram } from './program-resume.ts';
import { openAdmin } from './program-seal.ts';
import { adminKeysOf } from './repo-admin-keys.ts';
import type { ProgramAuthority } from './repo-programs.ts';
import { bytesToHex } from './sun.ts';
import { tagRef } from './tag-ref.ts';
import { tagFixture } from './tags-test-fixtures.ts';

/** An org with a programmable per-tag keyset, and callers that program as a scanner of it. */
export async function programFixture() {
  const f = await tagFixture();
  const { kit } = f;
  const o = await f.org();
  const keyset = await sunKeyset(kit, o.org.id, { perTag: true });
  await run(kit.env.DB, 'UPDATE nfc_tag_keysets SET programmable = 1 WHERE id = ?', [keyset.id]);

  /** A scanner of an org, with a staff member signed in or not. */
  async function authority(
    over: { scannerId?: string; staffId?: string | null; org?: typeof o } = {},
  ): Promise<ProgramAuthority> {
    const who = over.org ?? o;
    const authority = await who.authority();
    return {
      orgId: who.org.id,
      mode: 'live',
      principal: tenantPrincipal(authority),
      checks: capabilityChecks(authority),
      actor: { type: 'scanner', id: over.scannerId ?? 'scanner-1', staffId: over.staffId ?? null },
    };
  }

  /** The service behind the same calls the simulator's `programTag` makes. `tamper` rewrites what the device reports. */
  function port(
    a: ProgramAuthority,
    tamper: { url?: (url: string) => string; responses?: (batch: string[]) => string[] } = {},
    seen: string[][] = [],
    bind?: { passId: string; scope: 'pass' | 'user' },
  ): RelayPort & { last?: { refusal: string | null; state: string } } {
    const ctx = kit.ctx;
    const out: RelayPort & { last?: { refusal: string | null; state: string } } = {
      start: (req) => startProgram(ctx, a, req),
      async auth(id, req) {
        const step = await authProgram(ctx, a, id, req);
        seen.push(step.apdus);
        return step;
      },
      reauth: (id, req) => reauthProgram(ctx, a, id, req),
      async probe(id, req) {
        const step = await probeProgram(ctx, a, id, req);
        seen.push(step.apdus);
        return step;
      },
      async result(id, req) {
        const done = await resultProgram(
          ctx,
          a,
          id,
          TagProgramResultSchema.parse({
            responses: tamper.responses ? tamper.responses(req.responses) : req.responses,
            readback: {
              tech: 'isodep',
              source: 'native',
              ndef: { type: 'U', value: tamper.url ? tamper.url(req.url) : req.url },
            },
            ...(bind ? { bind } : {}),
          }),
        );
        out.last = done;
        return done;
      },
    };
    return out;
  }

  const sendOf =
    (sim: Ntag424Sim): Send =>
    (apdu) =>
      sim.transceive(apdu);

  /** Holds the tag again after each loss until the program finishes; returns how many holds it took. */
  async function finish(sim: Ntag424Sim, relay: RelayPort, limit = 4) {
    for (let holds = 1; holds <= limit; holds++) {
      try {
        return { url: await programTag(sendOf(sim), relay), holds };
      } catch (error) {
        if (!(error instanceof TagLostError)) throw error;
        sim.reattach();
      }
    }
    throw new Error('did not finish');
  }

  /** The program rows of a tag, oldest first. Never selects an envelope: only whether one is there. */
  async function rowsOf(sim: Ntag424Sim, orgId = o.org.id) {
    const { ref } = await tagRef(kit.env, orgId, 'live', bytesToHex(sim.tag.uid));
    return all<{
      id: string;
      state: string;
      step: string;
      attempts: number;
      error_code: string | null;
      kek_version: number | null;
      sess_kek_version: number | null;
      tag_id: string | null;
    }>(
      kit.env.DB,
      `SELECT id, state, step, attempts, error_code, kek_version, sess_kek_version, tag_id
         FROM nfc_tag_programs WHERE org_id = ? AND tag_ref = ? ORDER BY created_at, id`,
      [orgId, ref],
    );
  }

  /** What the database holds of a programmed tag, opened: its keys 0, 2, 3 and 4 and its counter. */
  async function stored(sim: Ntag424Sim, orgId = o.org.id) {
    const { ref } = await tagRef(kit.env, orgId, 'live', bytesToHex(sim.tag.uid));
    const tag = await first<{ id: string }>(
      kit.env.DB,
      'SELECT id FROM nfc_tags WHERE org_id = ? AND tag_ref = ?',
      [orgId, ref],
    );
    if (!tag) return null;
    const ring = await loadKekRing(kit.env);
    const scope = { orgId, mode: 'live' as const, keysetId: keyset.id };
    const sun = await first<{
      ctr: number;
      kek_version: number;
      iv: number[];
      wrapped_dek: number[];
      ciphertext: number[];
    }>(
      kit.env.DB,
      'SELECT ctr, kek_version, iv, wrapped_dek, ciphertext FROM nfc_tag_sun WHERE tag_id = ?',
      [tag.id],
    );
    const admin = await adminKeysOf(kit.env.DB, orgId, 'live', tag.id);
    const env = (r: NonNullable<typeof sun>) => ({
      kekVersion: r.kek_version,
      iv: new Uint8Array(r.iv),
      wrappedDek: new Uint8Array(r.wrapped_dek),
      ciphertext: new Uint8Array(r.ciphertext),
    });
    const k2 = sun ? await openTagKey(ring, scope, tag.id, env(sun)) : null;
    const keys = admin ? await openAdmin(ring, scope, tag.id, admin.envelope) : null;
    return { tagId: tag.id, ctr: sun?.ctr, k2, ...keys };
  }

  /** The tag holds exactly the keys the database does (K1 is the keyset's meta key, kept in the keyset). */
  async function expectKeysMatch(sim: Ntag424Sim, orgId = o.org.id) {
    const s = await stored(sim, orgId);
    const hex = (k: Uint8Array | null | undefined) => (k ? bytesToHex(k) : null);
    expect([hex(s?.k0), hex(s?.k2), hex(s?.k3), hex(s?.k4)]).toEqual(
      [0, 2, 3, 4].map((n) => bytesToHex(sim.tag.keys[n] as Uint8Array)),
    );
    expect(bytesToHex(sim.tag.keys[1] as Uint8Array)).toBe(bytesToHex(keyset.meta));
    return s;
  }

  return {
    ...f,
    o,
    keyset,
    authority,
    port,
    sendOf,
    finish,
    abortProgram,
    rowsOf,
    stored,
    expectKeysMatch,
  };
}

export type ProgramFixture = Awaited<ReturnType<typeof programFixture>>;
