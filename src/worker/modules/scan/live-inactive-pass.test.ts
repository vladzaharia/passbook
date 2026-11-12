import { describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { hub, kit, photoFixture } from './scan-hub-test-fixtures.ts';

// A voided or removed pass (an undo of one publishes its card through candidateById, which only
// excludes deleted and quarantined passes) must reach a screen as the redacted event, never as
// its holder, pass or photo.
describe('live hub inactive passes', () => {
  it.each([
    ['removed', 'UPDATE passes SET removed_at = ? WHERE id = ?'],
    ['voided', "UPDATE passes SET status = 'voided', modified_at = ? WHERE id = ?"],
  ] as const)('shows a %s pass as the redacted event only', async (_kind, sql) => {
    const f = await photoFixture();
    const active = (await hub().snapshot(f.monitor.attachment)).rows.find(
      (item) => item.id === f.event.id,
    );
    expect(active).toMatchObject({ passId: f.pass.id, photoUrl: expect.any(String) });
    await run(kit.env.DB, sql, [kit.clock.now(), f.pass.id]);
    const shown = (await hub().snapshot(f.monitor.attachment)).rows.find(
      (item) => item.id === f.event.id,
    );
    expect(shown).toBeDefined();
    expect(shown?.passId ?? null).toBeNull();
    expect(shown?.holder ?? null).toBeNull();
    expect(shown?.photoUrl ?? null).toBeNull();
    expect(JSON.stringify(shown)).not.toContain(f.pass.id);
  });
});
