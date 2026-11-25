import { beforeAll, describe, expect, it } from 'vitest';
import { countingRandom } from './ntag424/sim/fixtures.ts';
import { programTag } from './ntag424/sim/program.ts';
import { Ntag424Sim } from './ntag424/sim/tag.ts';
import { type ProgramFixture, programFixture } from './program-test-fixtures.ts';

// No mock here: the service checks originality against NXP's own key, which no simulator can sign for.
let f: ProgramFixture;
beforeAll(async () => {
  f = await programFixture();
});

describe('originality against the real NXP key', () => {
  it('refuses a tag the simulator signed, and makes no row for it', async () => {
    const tag = new Ntag424Sim({ random: countingRandom() });
    await expect(programTag(f.sendOf(tag), f.port(await f.authority()))).rejects.toMatchObject({
      code: 'TAG_NOT_GENUINE',
    });
    expect(await f.rowsOf(tag)).toEqual([]);
    // Nothing past version, signature and part 1 reached the tag.
    expect(tag.tag.versions).toEqual([0, 0, 0, 0, 0]);
  });
});
