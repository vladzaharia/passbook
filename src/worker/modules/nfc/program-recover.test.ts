import { beforeAll, describe, expect, it, vi } from 'vitest';
import { countingRandom } from './ntag424/sim/fixtures.ts';
import { programTag } from './ntag424/sim/program.ts';
import { Ntag424Sim } from './ntag424/sim/tag.ts';
import { type ProgramFixture, programFixture } from './program-test-fixtures.ts';

vi.mock('./ntag424/originality.ts', () => import('./program-originality-test-fixtures.ts'));

let f: ProgramFixture;
beforeAll(async () => {
  f = await programFixture();
});

const uidOf = (n: number, phase: number) =>
  Uint8Array.from([0x04, 0x61, n, phase, 0x11, 0x22, 0x33]);

describe('the recovery rows of the design: a tear after each command, then holding the tag again', () => {
  it('knows how many commands a hold is', async () => {
    const sim = new Ntag424Sim({
      isoInSession: 'refuse',
      uid: uidOf(0, 0),
      random: countingRandom(),
    });
    await programTag(f.sendOf(sim), f.port(await f.authority({ scannerId: 'base' })));
    expect(sim.trace.length).toBe(16);
  });

  for (let n = 1; n <= 16; n++) {
    for (const phase of ['after', 'before'] as const) {
      it(`command ${n}, ${phase === 'after' ? 'answer lost' : 'command lost'}`, async () => {
        const sim = new Ntag424Sim({
          isoInSession: 'refuse',
          uid: uidOf(n, phase === 'after' ? 1 : 2),
          random: countingRandom(),
        });
        sim.tearAt(n, phase);
        const { holds } = await f.finish(sim, f.port(await f.authority()));
        expect(holds).toBe(2);
        // The tag holds exactly the keys the database sealed, and one row carried the tag through both holds.
        await f.expectKeysMatch(sim);
        expect(sim.tag.versions).toEqual([1, 1, 1, 1, 1]);
        const rows = await f.rowsOf(sim);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          state: 'programmed',
          kek_version: null,
          sess_kek_version: null,
        });
        expect(rows[0]?.attempts).toBeLessThanOrEqual(3);
      });
    }
  }

  it('three holds each torn at a different command still finish on the fourth, with the same keys', async () => {
    const sim = new Ntag424Sim({
      isoInSession: 'refuse',
      uid: uidOf(99, 9),
      random: countingRandom(),
    });
    const port = f.port(await f.authority());
    for (const at of [8, 14, 12]) {
      sim.tearAt(sim.commands + at, 'after');
      await expect(programTag(f.sendOf(sim), port)).rejects.toMatchObject({ name: 'TagLostError' });
      sim.reattach();
    }
    await programTag(f.sendOf(sim), port);
    await f.expectKeysMatch(sim);
    expect(await f.rowsOf(sim)).toHaveLength(1);
  });
});
