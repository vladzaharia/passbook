import { beforeAll, describe, expect, it, vi } from 'vitest';
import { makeScanner } from '../../../../test/helpers/index.ts';
import { TagProgramStartSchema } from '../../../shared/contracts/nfc-tag-programs.ts';
import { all, first, run } from '../../platform/db.ts';
import { INS, native, selectNdefApp, splitResponse } from './ntag424/apdu.ts';
import { authFirstApdu } from './ntag424/ev2.ts';
import { countingRandom } from './ntag424/sim/fixtures.ts';
import { programTag } from './ntag424/sim/program.ts';
import { Ntag424Sim } from './ntag424/sim/tag.ts';
import { startProgram } from './program.ts';
import { authProgram } from './program-auth.ts';
import { type ProgramFixture, programFixture } from './program-test-fixtures.ts';
import { bytesToHex, hexToBytes } from './sun.ts';

vi.mock('./ntag424/originality.ts', () => import('./program-originality-test-fixtures.ts'));

let f: ProgramFixture;
let seq = 0;
beforeAll(async () => {
  f = await programFixture();
});
const db = () => f.kit.env.DB;
const sim = () =>
  new Ntag424Sim({
    uid: Uint8Array.from([0x04, 0x62, 0, 0, 0, (++seq >> 8) & 255, seq & 255]),
    random: countingRandom(),
  });
const refused = (p: Promise<unknown>, code: string) => expect(p).rejects.toMatchObject({ code });

/** What a device sends first: the tag's own answers before any key. */
async function hello(tag: Ntag424Sim, over: Record<string, unknown> = {}) {
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
    idem: `idem-${++seq}-${Math.random().toString(36).slice(2)}`,
    ...over,
  });
}

describe('what a start refuses, before any key is used', () => {
  it('a tag the org already has', async () => {
    const tag = sim();
    await f.finish(tag, f.port(await f.authority()));
    tag.reattach();
    await refused(programTag(f.sendOf(tag), f.port(await f.authority())), 'TAG_KNOWN');
  });

  it('a bad originality signature, and no row for it', async () => {
    const tag = sim();
    tag.signature[5] = (tag.signature[5] as number) ^ 1;
    await refused(programTag(f.sendOf(tag), f.port(await f.authority())), 'TAG_NOT_GENUINE');
    expect(await f.rowsOf(tag)).toEqual([]);
  });

  it('a tag that is not an NTAG 424 DNA, a uid the version does not carry, a rekey and an unprogrammable keyset', async () => {
    const a = await f.authority();
    const tag = sim();
    const req = await hello(tag);
    const notBlank = (version: string) => ({ ...req, version });
    await refused(
      startProgram(f.kit.ctx, a, notBlank(`04ff${req.version.slice(4)}`)),
      'TAG_NOT_424',
    );
    await refused(startProgram(f.kit.ctx, a, { ...req, uid: '04aaaaaaaaaaaa' }), 'TAG_NOT_GENUINE');
    await refused(startProgram(f.kit.ctx, a, { ...req, purpose: 'rekey' }), 'TAG_PROGRAM_FAILED');
    await run(db(), 'UPDATE nfc_tag_keysets SET programmable = 0 WHERE id = ?', [f.keyset.id]);
    await refused(startProgram(f.kit.ctx, a, req), 'KEYSET_NOT_PROGRAMMABLE');
    await run(db(), 'UPDATE nfc_tag_keysets SET programmable = 1 WHERE id = ?', [f.keyset.id]);
    expect(await f.rowsOf(tag)).toEqual([]);
  });

  it('is off when the org has tags off', async () => {
    const a = await f.authority();
    await run(
      db(),
      "UPDATE settings SET value = '{\"enabled\":false}' WHERE scope = ? AND key = 'nfc.tags'",
      [`org:${f.o.org.id}`],
    );
    const req = await hello(sim());
    await refused(startProgram(f.kit.ctx, a, req), 'TAGS_OFF');
    await run(
      db(),
      "UPDATE settings SET value = '{\"enabled\":true}' WHERE scope = ? AND key = 'nfc.tags'",
      [`org:${f.o.org.id}`],
    );
  });
});

describe('a tag that is not blank', () => {
  it('is refused after one key, with no second try, and leaves no keys', async () => {
    const tag = sim();
    tag.tag.keys[0] = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
    await refused(programTag(f.sendOf(tag), f.port(await f.authority())), 'TAG_NOT_BLANK');
    expect(tag.trace.filter((x) => x === 0x9071)).toHaveLength(1);
    expect(await f.rowsOf(tag)).toMatchObject([{ state: 'failed', kek_version: null }]);
  });
});

describe('the attempt cap', () => {
  it('refuses a tag after six auth attempts without touching it, keeping the keys it released', async () => {
    const tag = sim();
    const port = f.port(await f.authority());
    for (let hold = 1; hold <= 6; hold++) {
      tag.tearAt(tag.commands + 8, 'after');
      await expect(programTag(f.sendOf(tag), port)).rejects.toMatchObject({ name: 'TagLostError' });
      tag.reattach();
    }
    expect(await f.rowsOf(tag)).toMatchObject([{ attempts: 6, state: 'scripted' }]);
    const before = tag.commands;
    await refused(programTag(f.sendOf(tag), port), 'TAG_PROGRAM_FAILED');
    // Version, signature and part 1 are free: no part 2 went to the tag.
    expect(tag.commands - before).toBe(6);
    expect(await f.rowsOf(tag)).toMatchObject([{ state: 'failed', attempts: 6 }]);
    expect((await f.rowsOf(tag))[0]?.kek_version).not.toBeNull();
    // It stays refused.
    tag.reattach();
    await refused(programTag(f.sendOf(tag), port), 'TAG_PROGRAM_FAILED');
  });
});

describe('what the read-back and the responses prove', () => {
  const finishClean = async (tag: Ntag424Sim) => {
    tag.reattach();
    const { holds } = await f.finish(tag, f.port(await f.authority()));
    expect(holds).toBe(1);
    await f.expectKeysMatch(tag);
    expect(await f.rowsOf(tag)).toHaveLength(1);
  };

  it('a read-back for another host, or another slug, is not committed; the next hold finishes it', async () => {
    for (const swap of [
      (u: string) => u.replace(/^https:\/\/[^/]+/, 'https://evil.example'),
      (u: string) => u.replace(f.keyset.slug, 'other001'),
    ]) {
      const tag = sim();
      await refused(
        programTag(f.sendOf(tag), f.port(await f.authority(), { url: swap })),
        'TAG_PROGRAM_FAILED',
      );
      expect(await f.rowsOf(tag)).toMatchObject([{ state: 'interrupted', sess_kek_version: null }]);
      expect(await f.stored(tag)).toBeNull();
      // The keys were written: the next hold proves the intended key 0 and rewrites only the NDEF.
      await finishClean(tag);
    }
  });

  it('a bad MAC on any response is a tear, and nothing is committed', async () => {
    const tag = sim();
    const flip = (batch: string[]) =>
      batch.map((r, i) =>
        i === 2 ? r.slice(0, -4) + (r.endsWith('00') ? 'ff' : '00') + r.slice(-2) : r,
      );
    await refused(
      programTag(f.sendOf(tag), f.port(await f.authority(), { responses: flip })),
      'TAG_PROGRAM_FAILED',
    );
    expect(await f.rowsOf(tag)).toMatchObject([{ state: 'interrupted' }]);
    expect(await f.stored(tag)).toBeNull();
    await finishClean(tag);
  });

  it('a short batch is a tag that moved', async () => {
    const tag = sim();
    await refused(
      programTag(f.sendOf(tag), f.port(await f.authority(), { responses: (b) => b.slice(0, 3) })),
      'TAG_MOVED',
    );
    expect(await f.rowsOf(tag)).toMatchObject([{ state: 'interrupted' }]);
    await finishClean(tag);
  });

  it('a read-back of another tag of the same keys is refused', async () => {
    const one = sim();
    const other = sim();
    await f.finish(other, f.port(await f.authority()));
    const otherUrl = (await import('./ntag424/sim/program.ts')).readUrl;
    const stolen = await otherUrl(f.sendOf(other));
    await refused(
      programTag(f.sendOf(one), f.port(await f.authority(), { url: () => stolen })),
      'TAG_PROGRAM_FAILED',
    );
  });
});

describe('a start and an auth that are sent twice', () => {
  it('the same start answers the same part 2, and an auth answered twice gets the same script', async () => {
    const a = await f.authority();
    const tag = sim();
    const req = await hello(tag);
    const first = await startProgram(f.kit.ctx, a, req);
    expect(await startProgram(f.kit.ctx, a, req)).toEqual(first);
    expect((await f.rowsOf(tag))[0]?.attempts).toBe(1);
    // The device answers part 2; the server releases the script once, and again to a repeat.
    const send = f.sendOf(tag);
    const answer = bytesToHex(await send(hexToBytes(first.apdus[0] as string) as Uint8Array));
    const one = await authProgram(f.kit.ctx, a, first.id, { responses: [answer] });
    const two = await authProgram(f.kit.ctx, a, first.id, { responses: [answer] });
    expect(two).toEqual(one);
    expect(one.next).toBe('script');
    // Another answer for the same hold is not the script's.
    await refused(
      authProgram(f.kit.ctx, a, first.id, { responses: [`${answer.slice(0, -4)}9100`] }),
      'TAG_PROGRAM_FAILED',
    );
  });

  it('a script holds only native secure-messaging commands: no ISO command, no GetVersion, no Read_Sig', async () => {
    const seen: string[][] = [];
    const tag = sim();
    await f.finish(tag, f.port(await f.authority(), {}, seen));
    const ins = new Set(seen.flat().map((apdu) => apdu.slice(0, 4)));
    expect([...ins].sort()).toEqual(['908d', '905f', '90c4'].sort());
  });
});

describe('time, and whose hold it is', () => {
  it('a hold past its minute is closed, and its session is gone', async () => {
    const a = await f.authority();
    const tag = sim();
    const req = await hello(tag);
    const started = await startProgram(f.kit.ctx, a, req);
    f.kit.clock.advance(61_000);
    await refused(
      authProgram(f.kit.ctx, a, started.id, { responses: ['91af'] }),
      'TAG_PROGRAM_EXPIRED',
    );
    expect(await f.rowsOf(tag)).toMatchObject([
      { state: 'failed', error_code: 'TAG_PROGRAM_EXPIRED', sess_kek_version: null },
    ]);
  });

  it('another scanner cannot continue a hold, and another org cannot see it', async () => {
    const a = await f.authority();
    const tag = sim();
    const started = await startProgram(f.kit.ctx, a, await hello(tag));
    const otherScanner = await f.authority({ scannerId: 'scanner-2' });
    await refused(
      authProgram(f.kit.ctx, otherScanner, started.id, { responses: ['91af'] }),
      'TAG_NOT_FOUND',
    );
    const other = await f.org();
    const outsider = await f.authority({ org: other });
    await refused(
      authProgram(f.kit.ctx, outsider, started.id, { responses: ['91af'] }),
      'TAG_NOT_FOUND',
    );
  });

  it('the same tag programs in two orgs, each with its own keys', async () => {
    const other = await f.org();
    const { sunKeyset } = await import('../scan/sun-test-fixtures.ts');
    const second = await sunKeyset(f.kit, other.org.id, { perTag: true });
    await run(db(), 'UPDATE nfc_tag_keysets SET programmable = 1 WHERE id = ?', [second.id]);
    const tag = sim();
    await f.finish(tag, f.port(await f.authority()));
    // The tag now holds the first org's keys: the second org sees a tag that is not blank and not its own.
    tag.reattach();
    await refused(
      programTag(f.sendOf(tag), f.port(await f.authority({ org: other }))),
      'TAG_NOT_BLANK',
    );
    expect(await f.rowsOf(tag, other.org.id)).toMatchObject([{ state: 'failed' }]);
    expect(await f.rowsOf(tag)).toMatchObject([{ state: 'programmed' }]);
    const tags = await all<{ org_id: string }>(
      db(),
      'SELECT org_id FROM nfc_tags WHERE org_id IN (?, ?)',
      [f.o.org.id, other.org.id],
    );
    expect(tags.filter((t) => t.org_id === other.org.id)).toEqual([]);
  });
});

describe('program and assign', () => {
  it('binds the new tag to the pass in the same commit', async () => {
    const pass = await f.pass(f.o.org.id);
    const tag = sim();
    const scanner = await makeScanner(f.kit.fx, { orgId: f.o.org.id });
    const a = await f.authority({ scannerId: scanner.id });
    const port = f.port(a, {}, [], { passId: pass.id, scope: 'pass' });
    await programTag(f.sendOf(tag), port);
    const stored = await f.stored(tag);
    const bound = await first<{ pass_id: string; source: string }>(
      db(),
      'SELECT pass_id, source FROM tag_bindings WHERE tag_id = ? AND ended_at IS NULL',
      [stored?.tagId],
    );
    expect(bound).toEqual({ pass_id: pass.id, source: 'scanner' });
  });

  it('programs the tag as a spare, and says why, when the pass is gone', async () => {
    const tag = sim();
    const a = await f.authority();
    const port = f.port(a, {}, [], { passId: 'no-such-pass', scope: 'pass' });
    await programTag(f.sendOf(tag), port);
    expect(await f.stored(tag)).not.toBeNull();
    expect(port.last?.refusal).toBe('PASS_NOT_FOUND');
    const none = await first<{ n: number }>(
      db(),
      'SELECT count(*) AS n FROM tag_bindings WHERE tag_id = ?',
      [(await f.stored(tag))?.tagId],
    );
    expect(none?.n).toBe(0);
  });
});
