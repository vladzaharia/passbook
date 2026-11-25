import { beforeAll, describe, expect, it, vi } from 'vitest';
import { makeScanner } from '../../../../test/helpers/index.ts';
import { TagProgramStartSchema } from '../../../shared/contracts/nfc-tag-programs.ts';
import { all, first, run } from '../../platform/db.ts';
import type { insertType } from '../scan/tags-policy-test-fixtures.ts';
import { INS, native, selectNdefApp, splitResponse } from './ntag424/apdu.ts';
import { ZERO16 } from './ntag424/bytes.ts';
import { authFirstApdu } from './ntag424/ev2.ts';
import { countingRandom } from './ntag424/sim/fixtures.ts';
import { authenticate, programTag } from './ntag424/sim/program.ts';
import { Ntag424Sim } from './ntag424/sim/tag.ts';
import { startProgram } from './program.ts';
import { authProgram } from './program-auth.ts';
import { resultProgram } from './program-commit.ts';
import { abortProgram } from './program-resume.ts';
import { type ProgramFixture, programFixture } from './program-test-fixtures.ts';
import { bytesToHex } from './sun.ts';

vi.mock('./ntag424/originality.ts', () => import('./program-originality-test-fixtures.ts'));

let f: ProgramFixture;
let seq = 0;
beforeAll(async () => {
  f = await programFixture();
});
const db = () => f.kit.env.DB;
const sim = () =>
  new Ntag424Sim({
    uid: Uint8Array.from([0x04, 0x64, 0, 0, 0, (++seq >> 8) & 255, seq & 255]),
    random: countingRandom(),
    endSessionOnIso: true,
  });
const refused = (p: Promise<unknown>, code: string) => expect(p).rejects.toMatchObject({ code });
const lost = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ name: 'TagLostError' });

async function hello(tag: Ntag424Sim) {
  const send = f.sendOf(tag);
  await send(selectNdefApp());
  const hw = splitResponse(await send(native(INS.getVersion))).data;
  const sw = splitResponse(await send(native(INS.additional))).data;
  const prod = splitResponse(await send(native(INS.additional))).data;
  const sig = splitResponse(await send(native(INS.readSig, new Uint8Array([0])))).data;
  const auth1 = splitResponse(await send(authFirstApdu(0))).data;
  return TagProgramStartSchema.parse({
    uid: bytesToHex(prod.slice(0, 7)),
    version: bytesToHex(new Uint8Array([...hw, ...sw, ...prod])),
    sig: bytesToHex(sig),
    auth1: bytesToHex(auth1),
    purpose: 'blank',
    idem: `take-${++seq}-${Math.random().toString(36).slice(2)}`,
  });
}

describe('two scanners on one tag', () => {
  it('a live hold is not taken: the second scanner is busy until the first one expires', async () => {
    const tag = sim();
    const a = await f.authority({ scannerId: 'busy-a' });
    const b = await f.authority({ scannerId: 'busy-b' });
    const started = await startProgram(f.kit.ctx, a, await hello(tag));
    await refused(startProgram(f.kit.ctx, b, await hello(tag)), 'TAG_PROGRAM_BUSY');
    // The first scanner still holds it.
    expect((await f.rowsOf(tag))[0]).toMatchObject({ state: 'started' });
    f.kit.clock.advance(61_000);
    expect((await startProgram(f.kit.ctx, b, await hello(tag))).id).toBe(started.id);
    // The first scanner's late answers find another hold, not its own.
    await refused(authProgram(f.kit.ctx, a, started.id, { responses: ['9100'] }), 'TAG_NOT_FOUND');
  });
});

describe('keys go back to the scanner that released them, or a Manager', () => {
  it('another scanner is refused, a Manager finishes the tag, and the audit says so', async () => {
    const tag = sim();
    const a = await f.authority({ scannerId: 'rel-a' });
    tag.tearAt(8, 'after');
    await lost(programTag(f.sendOf(tag), f.port(a)));
    tag.reattach();
    f.kit.clock.advance(61_000);
    const other = await f.authority({ scannerId: 'rel-b' });
    await refused(programTag(f.sendOf(tag), f.port(other)), 'TAG_PROGRAM_FAILED');
    tag.reattach();
    const manager = await f.authority({ scannerId: 'rel-b', manager: true });
    await f.finish(tag, f.port(manager));
    await f.expectKeysMatch(tag);
    const audit = await all<{ detail: string }>(
      db(),
      "SELECT detail FROM audit_log WHERE action = 'nfc_tag.program_started' AND detail LIKE '%keysTo%'",
    );
    expect(audit.map((r) => JSON.parse(r.detail).keysTo)).toContain('manager');
    // The original scanner finishing its own tag is told apart in the audit.
    const mine = sim();
    mine.tearAt(8, 'after');
    await lost(programTag(f.sendOf(mine), f.port(a)));
    mine.reattach();
    f.kit.clock.advance(61_000);
    await f.finish(mine, f.port(a));
    const again = await all<{ detail: string }>(
      db(),
      "SELECT detail FROM audit_log WHERE action = 'nfc_tag.program_started' AND detail LIKE '%releaser%'",
    );
    expect(again.length).toBeGreaterThan(0);
  });
});

describe('the keyed recovery script closes the session', () => {
  it('ends with ChangeKey 0 on the same key, and the read-back follows an ended session', async () => {
    const tag = sim();
    const a = await f.authority({ scannerId: 'keyed' });
    // The last ChangeKey (key 0, command 14) lands and its answer is lost.
    tag.tearAt(14, 'after');
    await lost(programTag(f.sendOf(tag), f.port(a)));
    tag.reattach();
    const seen: string[][] = [];
    await programTag(f.sendOf(tag), f.port(a, {}, seen));
    const script = seen.at(-1) ?? [];
    expect(script).toHaveLength(3);
    expect(script.map((apdu) => apdu.slice(0, 4))).toEqual(['908d', '905f', '90c4']);
    await f.expectKeysMatch(tag);
  });

  it('the simulator ends an authenticated session on an ISO command', async () => {
    const tag = sim();
    await authenticate(f.sendOf(tag), 0, ZERO16);
    expect(tag.tag.session).not.toBeNull();
    await f.sendOf(tag)(selectNdefApp());
    expect(tag.tag.session).toBeNull();
  });
});

describe('the entitlement', () => {
  it('programming needs Secure tags, not just Basic', async () => {
    const o = await f.org();
    await run(
      db(),
      `INSERT OR REPLACE INTO org_entitlement_overrides (org_id, key, value, updated_at) VALUES (?, 'nfc', '"basic"', 1)`,
      [o.org.id],
    );
    const tag = sim();
    await refused(
      startProgram(f.kit.ctx, await f.authority({ org: o }), await hello(tag)),
      'FEATURE_NOT_INCLUDED',
    );
  });
});

describe('program and assign follows the bind policy', () => {
  /** A fixture whose keyset has a tag type, with a scanner of its org and a scannable pass. */
  async function typed(spec: Parameters<typeof insertType>[2]) {
    const t = await programFixture({ type: spec });
    const scanner = await makeScanner(t.kit.fx, { orgId: t.o.org.id });
    return { t, o: t.o, scanner, pass: await t.pass(t.o.org.id) };
  }
  const bindOf = async (tag: Ntag424Sim, orgId: string) =>
    first<{ id: string; expires_at: number | null }>(
      db(),
      `SELECT b.id, b.expires_at FROM tag_bindings b JOIN nfc_tags t ON t.id = b.tag_id
        WHERE t.org_id = ? AND b.ended_at IS NULL ORDER BY b.bound_at DESC`,
      [orgId],
    ).then((r) => (tag ? r : r));

  it('binds with the type, and the binding takes the type expiry', async () => {
    const { t, o, scanner, pass } = await typed({ bindingDays: 7 });
    const a = await t.authority({ scannerId: scanner.id });
    const tag = sim();
    const port = t.port(a, {}, [], { passId: pass.id, scope: 'pass' });
    await programTag(t.sendOf(tag), port);
    expect(port.last?.refusal).toBeNull();
    expect((await bindOf(tag, o.org.id))?.expires_at).not.toBeNull();
  });

  it('a type that takes people only leaves the tag a spare, with the type refusal', async () => {
    const { t, scanner, pass } = await typed({ scopes: 'user' });
    const a = await t.authority({ scannerId: scanner.id });
    const port = t.port(a, {}, [], { passId: pass.id, scope: 'pass' });
    await programTag(t.sendOf(sim()), port);
    expect(port.last?.refusal).toBe('TAG_TYPE_SCOPE');
  });

  it('the per-pass limit of the type refuses the second tag', async () => {
    const { t, scanner, pass } = await typed({ perPass: 1 });
    const a = await t.authority({ scannerId: scanner.id });
    const one = t.port(a, {}, [], { passId: pass.id, scope: 'pass' });
    await programTag(t.sendOf(sim()), one);
    expect(one.last?.refusal).toBeNull();
    const two = t.port(a, {}, [], { passId: pass.id, scope: 'pass' });
    await programTag(t.sendOf(sim()), two);
    expect(two.last?.refusal).toBe('TAG_TYPE_LIMIT');
  });

  it('the actor needs the right to assign, and the wider one to assign to a person', async () => {
    const { t, scanner, pass } = await typed({});
    for (const [rights, scope] of [
      [{ assign: false, assignAll: false }, 'pass'],
      [{ assign: true, assignAll: false }, 'user'],
    ] as const) {
      const a = await t.authority({ scannerId: scanner.id, rights });
      const port = t.port(a, {}, [], { passId: pass.id, scope });
      await programTag(t.sendOf(sim()), port);
      expect(port.last?.refusal).toBe('TAG_ASSIGN_FORBIDDEN');
    }
  });

  it('a repeated result gets the first refusal, for the same scanner only', async () => {
    const { t, scanner, pass } = await typed({});
    const a = await t.authority({
      scannerId: scanner.id,
      rights: { assign: false, assignAll: false },
    });
    const port = t.port(a, {}, [], { passId: pass.id, scope: 'pass' });
    await programTag(t.sendOf(sim()), port);
    const id = port.lastId as string;
    const input = port.lastInput as NonNullable<typeof port.lastInput>;
    expect(await resultProgram(t.kit.ctx, a, id, input)).toMatchObject({
      state: 'programmed',
      refusal: 'TAG_ASSIGN_FORBIDDEN',
    });
    const other = await t.authority({ scannerId: 'someone-else' });
    await refused(resultProgram(t.kit.ctx, other, id, input), 'TAG_NOT_FOUND');
  });
});

describe('an abort belongs to the hold', () => {
  it('another scanner cannot abort or ask about it', async () => {
    const tag = sim();
    const a = await f.authority({ scannerId: 'abort-a' });
    const started = await startProgram(f.kit.ctx, a, await hello(tag));
    const b = await f.authority({ scannerId: 'abort-b' });
    await refused(
      abortProgram(f.kit.ctx, b, started.id, { responses: [], why: 'cancelled' }),
      'TAG_NOT_FOUND',
    );
    expect(
      await abortProgram(f.kit.ctx, a, started.id, { responses: [], why: 'cancelled' }),
    ).toEqual({
      state: 'interrupted',
    });
    await refused(
      abortProgram(f.kit.ctx, b, started.id, { responses: [], why: 'cancelled' }),
      'TAG_NOT_FOUND',
    );
  });
});

describe('a builder that refuses ends the hold', () => {
  it('a host too long for one write is a mapped code and a closed hold, not an unhandled error', async () => {
    const env = f.kit.env as { PUBLIC_BASE_URL: string };
    const before = env.PUBLIC_BASE_URL;
    env.PUBLIC_BASE_URL = `https://${'a'.repeat(240)}.example`;
    try {
      const tag = sim();
      await refused(programTag(f.sendOf(tag), f.port(await f.authority())), 'TAG_NOT_424');
      expect(await f.rowsOf(tag)).toMatchObject([{ state: 'failed', sess_kek_version: null }]);
    } finally {
      env.PUBLIC_BASE_URL = before;
    }
  });
});
