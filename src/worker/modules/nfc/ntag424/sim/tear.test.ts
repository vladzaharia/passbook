import { describe, expect, it } from 'vitest';
import { bytesToHex, verifySun } from '../../sun.ts';
import { parseSunUrl } from '../../sun-url.ts';
import { countingRandom, testPlan, ZERO16 } from './fixtures.ts';
import { authenticate, programTag } from './program.ts';
import { RelayServer } from './relay-server.ts';
import { TagLostError } from './state.ts';
import { Ntag424Sim } from './tag.ts';

const sendOf = (sim: Ntag424Sim) => (apdu: Uint8Array) => sim.transceive(apdu);
const plan = testPlan();

/** Every command of an uninterrupted program, in order. */
const baseline = (async () => {
  const sim = new Ntag424Sim({ random: countingRandom() });
  await programTag(sendOf(sim), new RelayServer(plan, countingRandom()));
  return sim.trace;
})();

/** Holds the tag again after each loss until the program finishes; returns how many holds it took. */
async function finish(
  sim: Ntag424Sim,
  server: RelayServer,
  limit = 4,
): Promise<{ url: string; holds: number }> {
  for (let holds = 1; holds <= limit; holds++) {
    try {
      return { url: await programTag(sendOf(sim), server), holds };
    } catch (e) {
      if (!(e instanceof TagLostError)) throw e;
      sim.reattach();
    }
  }
  throw new Error('did not finish');
}

async function expectProgrammed(sim: Ntag424Sim, url: string) {
  expect(sim.tag.keys.map(bytesToHex)).toEqual(plan.keys.map(bytesToHex));
  expect(sim.tag.versions).toEqual([3, 3, 3, 3, 3]);
  const tap = parseSunUrl(url) as { p: string; m: string };
  const read = await verifySun(
    {
      metaKey: plan.keys[1] as Uint8Array,
      fileKey: plan.keys[2] as Uint8Array,
      diversified: false,
    },
    tap.p,
    tap.m,
  );
  expect(read).toMatchObject({ ok: true, read: { uid: bytesToHex(sim.tag.uid) } });
}

describe('a tear after every command, then holding the tag again', () => {
  it('knows how many commands a program is', async () => {
    expect((await baseline).length).toBe(16);
  });

  for (let n = 1; n <= 16; n++) {
    for (const phase of ['after', 'before'] as const) {
      it(`command ${n}, ${phase === 'after' ? 'answer lost' : 'command lost'}`, async () => {
        const sim = new Ntag424Sim({ random: countingRandom() });
        sim.tearAt(n, phase);
        const { url, holds } = await finish(sim, new RelayServer(plan, countingRandom()));
        expect(holds).toBe(2);
        await expectProgrammed(sim, url);
      });
    }
  }

  it('after the last ChangeKey the factory key is gone: the next hold authenticates with the intended key 0', async () => {
    const trace = await baseline;
    const last = trace.lastIndexOf(0x90c4) + 1;
    const sim = new Ntag424Sim({ random: countingRandom() });
    const server = new RelayServer(plan, countingRandom());
    sim.tearAt(last, 'after');
    await expect(programTag(sendOf(sim), server)).rejects.toBeInstanceOf(TagLostError);
    expect(sim.tag.keys[0]).toEqual(plan.keys[0]);
    sim.reattach();
    await expect(authenticate(sendOf(sim), 0, ZERO16)).rejects.toMatchObject({
      code: 'NTAG_AUTH_FAILED',
    });
    sim.reattach();
    await expectProgrammed(sim, await programTag(sendOf(sim), server));
  });

  it('after some keys changed, key versions say which slots hold the new key and the rest still change from zero', async () => {
    const trace = await baseline;
    const second = trace.indexOf(0x90c4, trace.indexOf(0x90c4) + 1) + 1;
    const sim = new Ntag424Sim({ random: countingRandom() });
    const server = new RelayServer(plan, countingRandom());
    sim.tearAt(second, 'after');
    await expect(programTag(sendOf(sim), server)).rejects.toBeInstanceOf(TagLostError);
    expect(sim.tag.versions).toEqual([0, 3, 3, 0, 0]);
    sim.reattach();
    await expectProgrammed(sim, await programTag(sendOf(sim), server));
  });

  it('three holds each torn at a different command still finish on the fourth', async () => {
    const sim = new Ntag424Sim({ random: countingRandom() });
    const server = new RelayServer(plan, countingRandom());
    for (const at of [8, 14, 12]) {
      sim.tearAt(sim.commands + at, 'after');
      await expect(programTag(sendOf(sim), server)).rejects.toBeInstanceOf(TagLostError);
      sim.reattach();
    }
    await expectProgrammed(sim, await programTag(sendOf(sim), server));
  });
});
