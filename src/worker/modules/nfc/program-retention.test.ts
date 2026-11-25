import { beforeAll, describe, expect, it, vi } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { createJobContext } from '../../platform/service-context.ts';
import { countingRandom } from './ntag424/sim/fixtures.ts';
import { programTag } from './ntag424/sim/program.ts';
import { Ntag424Sim } from './ntag424/sim/tag.ts';
import { sweepPrograms } from './program-retention.ts';
import { type ProgramFixture, programFixture } from './program-test-fixtures.ts';

vi.mock('./ntag424/originality.ts', () => import('./program-originality-test-fixtures.ts'));

let f: ProgramFixture;
beforeAll(async () => {
  f = await programFixture();
});
const DAY = 86_400_000;
const job = () => createJobContext(f.kit.env, 'nfc.programs', { clock: f.kit.clock });

describe('the daily sweep of programs', () => {
  it('never purges an abandoned row that still holds keys', async () => {
    const tag = new Ntag424Sim({
      uid: Uint8Array.from([4, 0x63, 9, 9, 9, 9, 9]),
      random: countingRandom(),
    });
    const a = await f.authority();
    tag.tearAt(8, 'after');
    await expect(programTag(f.sendOf(tag), f.port(a))).rejects.toMatchObject({
      name: 'TagLostError',
    });
    f.kit.clock.advance(2 * 60_000);
    await sweepPrograms(job());
    await run(
      f.kit.env.DB,
      "UPDATE nfc_tag_programs SET state = 'abandoned' WHERE state = 'interrupted' AND org_id = ?",
      [f.o.org.id],
    );
    f.kit.clock.advance(401 * DAY);
    await sweepPrograms(job());
    expect(await f.rowsOf(tag)).toMatchObject([{ state: 'abandoned' }]);
  });

  it('closes holds nobody ended, clears their sessions, and deletes ended rows past retention', async () => {
    // A hold that started and was dropped: keyless, then one that released its keys.
    const dropped = new Ntag424Sim({
      uid: Uint8Array.from([4, 0x63, 1, 1, 1, 1, 1]),
      random: countingRandom(),
    });
    const torn = new Ntag424Sim({
      uid: Uint8Array.from([4, 0x63, 2, 2, 2, 2, 2]),
      random: countingRandom(),
    });
    const a = await f.authority();
    dropped.tearAt(7, 'before');
    await expect(programTag(f.sendOf(dropped), f.port(a))).rejects.toMatchObject({
      name: 'TagLostError',
    });
    torn.tearAt(8, 'after');
    await expect(programTag(f.sendOf(torn), f.port(a))).rejects.toMatchObject({
      name: 'TagLostError',
    });
    const done = new Ntag424Sim({
      uid: Uint8Array.from([4, 0x63, 3, 3, 3, 3, 3]),
      random: countingRandom(),
    });
    await f.finish(done, f.port(a));

    f.kit.clock.advance(2 * 60_000);
    await sweepPrograms(job());
    expect(await f.rowsOf(dropped)).toMatchObject([
      { state: 'failed', error_code: 'TAG_PROGRAM_EXPIRED', sess_kek_version: null },
    ]);
    expect(await f.rowsOf(torn)).toMatchObject([
      { state: 'interrupted', error_code: 'TAG_PROGRAM_EXPIRED', sess_kek_version: null },
    ]);
    // The torn tag still resumes from its row.
    torn.reattach();
    await f.finish(torn, f.port(a));
    await f.expectKeysMatch(torn);

    f.kit.clock.advance(401 * DAY);
    await sweepPrograms(job());
    expect(await f.rowsOf(dropped)).toEqual([]);
    expect(await f.rowsOf(done)).toEqual([]);
    // The tags themselves stay.
    expect(await f.stored(done)).not.toBeNull();
    const left = await first<{ n: number }>(
      f.kit.env.DB,
      'SELECT count(*) AS n FROM nfc_tag_programs WHERE org_id = ?',
      [f.o.org.id],
    );
    expect(left?.n).toBe(0);
    void all;
    void run;
  });
});
