import { expect } from 'vitest';
import type { z } from 'zod';
import { makeOrg, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { TagProgramResultSchema } from '../../../shared/contracts/nfc-tag-programs.ts';
import { loadKekRing } from '../../platform/crypto.ts';
import { all, first, run } from '../../platform/db.ts';
import { resolveSession } from '../auth/sessions.ts';
import { grantKitMembership } from '../passes/apple-release-test-fixtures.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { capabilityChecks, tenantPrincipal } from '../passes/repo-authority.ts';
import { sunKeyset } from '../scan/sun-test-fixtures.ts';
import { insertType } from '../scan/tags-policy-test-fixtures.ts';
import { tagScanFixture } from '../scan/tags-scan-test-fixtures.ts';
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
import { tagAuthorityOf } from './tags-admin.ts';

/** The relay the simulator drives, with what the service last answered and was sent. */
export type ProgramPort = RelayPort & {
  last?: { refusal: string | null; state: string };
  lastId?: string;
  lastInput?: z.infer<typeof TagProgramResultSchema>;
};

/**
 * An org with a programmable per-tag keyset (of a tag type, when asked), and callers that program as a scanner of
 * it. Its passes are scannable: they have a release, so the bind policy can read them.
 */
export async function programFixture(options: { type?: Parameters<typeof insertType>[2] } = {}) {
  const base = await tagScanFixture();
  const { kit } = base;
  type Row = { id: string };

  /** An org with a pass operator whose captured authority a program grant can stand on. */
  async function memberOf(row: Row) {
    const operator = await makeUser(kit.fx);
    await grantKitMembership(kit, row.id, operator.id, ['pass_operator']);
    return {
      org: row,
      /** A fresh session per call, so a test that moves the clock past one still gets an authority. */
      async authority(mode: Mode = 'live') {
        const session = await makeSession(kit.fx, { userId: operator.id, roles: ['user'] });
        const resolved = await resolveSession(kit.env, kit.clock, session.cookieValue);
        if (!resolved) throw new Error('The operator session did not resolve.');
        return tagAuthorityOf(
          await tenantAuthorityOf(kit.ctx, { ...resolved, mode }, row.id, 'passes:operate'),
        );
      },
    };
  }
  const o = await memberOf(kit.org);
  /** Another org, with tags on unless `enabled` is false. */
  async function org(opts: { enabled?: boolean } = {}) {
    const row = await makeOrg(kit.fx);
    await run(
      kit.env.DB,
      "INSERT INTO settings (scope, key, value, updated_at) VALUES (?, 'nfc.tags', ?, 1)",
      [`org:${row.id}`, JSON.stringify({ enabled: opts.enabled !== false })],
    );
    return memberOf(row);
  }
  /** A scannable pass of the default org. */
  const pass = async (orgId: string) => {
    if (orgId !== kit.org.id) throw new Error('Scannable passes are made for the default org.');
    return (await base.pass()).pass;
  };
  const keyset = await sunKeyset(kit, o.org.id, { perTag: true });
  await run(kit.env.DB, 'UPDATE nfc_tag_keysets SET programmable = 1 WHERE id = ?', [keyset.id]);
  if (options.type) {
    const type = await insertType(kit, o.org.id, { system: 'sun', ...options.type });
    await run(kit.env.DB, 'UPDATE nfc_tag_keysets SET type_id = ? WHERE id = ?', [type, keyset.id]);
  }
  const f = { kit, org, pass };

  /** A scanner of an org, with a staff member signed in or not. */
  async function authority(
    over: {
      scannerId?: string;
      staffId?: string | null;
      org?: typeof o;
      manager?: boolean;
      rights?: { assign: boolean; assignAll: boolean };
    } = {},
  ): Promise<ProgramAuthority> {
    const who = over.org ?? o;
    const authority = await who.authority();
    return {
      orgId: who.org.id,
      mode: 'live',
      principal: tenantPrincipal(authority),
      checks: capabilityChecks(authority),
      actor: { type: 'scanner', id: over.scannerId ?? 'scanner-1', staffId: over.staffId ?? null },
      manager: over.manager ?? false,
      rights: over.rights ?? { assign: true, assignAll: true },
    };
  }

  /** The service behind the same calls the simulator's `programTag` makes. `tamper` rewrites what the device reports. */
  function port(
    a: ProgramAuthority,
    tamper: { url?: (url: string) => string; responses?: (batch: string[]) => string[] } = {},
    seen: string[][] = [],
    bind?: { passId: string; scope: 'pass' | 'user' },
  ): ProgramPort {
    const ctx = kit.ctx;
    const out: ProgramPort = {
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
        const input = TagProgramResultSchema.parse({
          responses: tamper.responses ? tamper.responses(req.responses) : req.responses,
          readback: {
            tech: 'isodep',
            source: 'native',
            ndef: { type: 'U', value: tamper.url ? tamper.url(req.url) : req.url },
          },
          ...(bind ? { bind } : {}),
        });
        out.lastId = id;
        out.lastInput = input;
        const done = await resultProgram(ctx, a, id, input);
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
