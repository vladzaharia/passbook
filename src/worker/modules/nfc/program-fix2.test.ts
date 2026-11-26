import { beforeAll, describe, expect, it, vi } from 'vitest';
import { makeScanner } from '../../../../test/helpers/index.ts';
import { TagProgramStartSchema } from '../../../shared/contracts/nfc-tag-programs.ts';
import { all, first } from '../../platform/db.ts';
import { INS, native, selectNdefApp, splitResponse } from './ntag424/apdu.ts';
import { authFirstApdu } from './ntag424/ev2.ts';
import { countingRandom } from './ntag424/sim/fixtures.ts';
import { programTag } from './ntag424/sim/program.ts';
import { Ntag424Sim } from './ntag424/sim/tag.ts';
import { startProgram } from './program.ts';
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
const sim = (uid?: Uint8Array) =>
  new Ntag424Sim({
    isoInSession: 'refuse',
    uid: uid ?? Uint8Array.from([0x04, 0x65, 0, 0, 0, (++seq >> 8) & 255, seq & 255]),
    random: countingRandom(),
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
    idem: `fix2-${++seq}-${Math.random().toString(36).slice(2)}`,
  });
}

/** A tag torn mid-script, then its hold ended by the releaser: an interrupted row with keys and no session. */
async function interrupted(scannerId: string, at = 8) {
  const tag = sim();
  const a = await f.authority({ scannerId });
  tag.tearAt(at, 'after');
  await lost(programTag(f.sendOf(tag), f.port(a)));
  tag.reattach();
  const row = (await f.rowsOf(tag))[0] as { id: string };
  await abortProgram(f.kit.ctx, a, row.id, { responses: [], why: 'cancelled' });
  return { tag, a, id: row.id };
}

describe('a resume of a row with no session is fenced', () => {
  it('two racing resumes: one wins, the other is busy', async () => {
    const { tag, id } = await interrupted('race-a');
    expect((await f.rowsOf(tag))[0]).toMatchObject({
      state: 'interrupted',
      sess_kek_version: null,
    });
    const a = await f.authority({ scannerId: 'race-a' });
    const b = await f.authority({ scannerId: 'race-b', manager: true });
    const [one, two] = await Promise.allSettled([
      startProgram(f.kit.ctx, a, await hello(tag)),
      startProgram(f.kit.ctx, b, await hello(tag)),
    ]);
    const states = [one, two].map((r) => r.status);
    expect(states.sort()).toEqual(['fulfilled', 'rejected']);
    const lose = [one, two].find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lose.reason).toMatchObject({ code: 'TAG_PROGRAM_BUSY' });
    expect((await f.rowsOf(tag))[0]).toMatchObject({ id, state: 'started' });
  });

  it('the attempt cap still ends a sessionless row', async () => {
    const { tag, a, id } = await interrupted('cap-a');
    // Each resume spends an attempt; the sixth hold is refused.
    for (let n = 0; n < 5; n++) {
      const resumed = await startProgram(f.kit.ctx, a, await hello(tag));
      await abortProgram(f.kit.ctx, a, resumed.id, { responses: [], why: 'cancelled' });
    }
    expect((await f.rowsOf(tag))[0]).toMatchObject({ id, attempts: 6 });
    await refused(startProgram(f.kit.ctx, a, await hello(tag)), 'TAG_PROGRAM_FAILED');
    expect((await f.rowsOf(tag))[0]).toMatchObject({ state: 'failed' });
  });
});

describe('a Manager resume onto a tag that reads fully blank', () => {
  it('is refused and audited as a suspected clone', async () => {
    const { tag } = await interrupted('clone-a', 12);
    // A different, blank tag with the same UID: a relay or a clone answering for the real one.
    const clone = sim(tag.tag.uid);
    const manager = await f.authority({ scannerId: 'clone-b', manager: true });
    await refused(programTag(f.sendOf(clone), f.port(manager)), 'TAG_PROGRAM_FAILED');
    expect((await f.rowsOf(tag))[0]).toMatchObject({ state: 'failed' });
    const rows = await all<{ detail: string }>(
      db(),
      "SELECT detail FROM audit_log WHERE action = 'nfc_tag.program_failed' AND detail LIKE '%TAG_CLONE_SUSPECTED%'",
    );
    expect(rows).toHaveLength(1);
  });
});

describe('a lapsed binding does not count against the per-pass limit', () => {
  it('the second tag binds and the lapsed binding ends', async () => {
    const t = await programFixture({ type: { bindingDays: 1, perPass: 1 } });
    const scanner = await makeScanner(t.kit.fx, { orgId: t.o.org.id });
    const pass = await t.pass(t.o.org.id);
    const a = await t.authority({ scannerId: scanner.id });
    const one = t.port(a, {}, [], { passId: pass.id, scope: 'pass' });
    await programTag(t.sendOf(sim()), one);
    expect(one.last?.refusal).toBeNull();
    t.kit.clock.advance(86_400_000 + 60_000);
    const later = await t.authority({ scannerId: scanner.id });
    const two = t.port(later, {}, [], { passId: pass.id, scope: 'pass' });
    await programTag(t.sendOf(sim()), two);
    expect(two.last?.refusal).toBeNull();
    const ended = await first<{ n: number }>(
      t.kit.env.DB,
      'SELECT COUNT(*) AS n FROM tag_bindings WHERE ended_at IS NOT NULL',
    );
    expect(ended?.n).toBe(1);
  });
});
