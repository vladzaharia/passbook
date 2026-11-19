import { describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { hub, kit, publish, row, screen, template } from './scan-hub-test-fixtures.ts';

/*
 * A monitor is a wall screen: it is sent the public row (outcome, direction, place, time) and never
 * the holder, pass id, photo or staff, whatever the pass or its state. Storage still scrubs the
 * holder once the pass is no longer visible.
 */

async function fixture() {
  const source = await kit.scanner({ templateIds: [template] });
  const monitor = await screen('monitor', [source.id], false, {}, undefined);
  const pass = await kit.scanPass(template, { memberName: 'Plain Row Member' });
  const png = btoa(String.fromCharCode(...makePng(270, 270)));
  await putMemberPhoto(
    kit.ctx,
    { type: 'system', id: null },
    pass.id,
    { png, includeInPass: false },
    null,
  );
  const event = row(source.id, { passId: pass.id });
  await publish(event);
  const shown = async () =>
    (await hub().snapshot(monitor.attachment, undefined, kit.clock.now())).rows.find(
      (item) => item.id === event.id,
    );
  return { source, monitor, pass, event, shown };
}

describe('live plain rows', () => {
  it('sends a monitor the public row only, whatever the pass', async () => {
    const f = await fixture();
    const shown = await f.shown();
    expect(shown).toMatchObject({ id: f.event.id, kind: 'ok', direction: 'in' });
    for (const key of [
      'holder',
      'passId',
      'photoUrl',
      'presented',
      'occupancy',
      'resolvedBy',
      'overrideOf',
    ])
      expect(shown).not.toHaveProperty(key);
    expect(JSON.stringify(shown)).not.toContain('Plain Row Member');
    expect(JSON.stringify(shown)).not.toContain(f.pass.id);
  });

  it('keeps a monitor row public after the pass is deleted', async () => {
    const f = await fixture();
    await run(kit.env.DB, 'UPDATE passes SET deleted_at = 1 WHERE id = ?', [f.pass.id]);
    const shown = await f.shown();
    expect(shown).toMatchObject({ id: f.event.id, kind: 'ok' });
    expect(shown).not.toHaveProperty('passId');
  });

  it('scrubs the holder name from storage once its pass is no longer visible', async () => {
    const f = await fixture();
    expect(await hub().ringRow(f.event.id)).toMatchObject({ row: { holder: 'Plain Row Member' } });
    await run(kit.env.DB, 'UPDATE passes SET deleted_at = 1 WHERE id = ?', [f.pass.id]);
    await publish(row(f.source.id));
    const stored = await hub().ringRow(f.event.id);
    expect(stored).toMatchObject({ gen: null, row: { holder: null, passId: null } });
    expect(JSON.stringify(stored)).not.toContain('Plain Row Member');
  });
});
