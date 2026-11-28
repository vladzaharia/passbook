import { describe, expect, it } from 'vitest';
import { hub, kit, publish, row, screen, template } from './scan-hub-test-fixtures.ts';

const refusal = {
  kind: 'refused',
  direction: null,
  label: 'Not accepted',
  reason: 'not_found',
} as const;

async function seen(role: 'desk' | 'door' | null) {
  const staff = role ? await kit.staff(role, `Reason ${role}`) : null;
  const source = await kit.scanner({
    templateIds: [template],
    ...(staff ? { settings: { staffSignIn: true }, staffId: staff.id } : {}),
  });
  const monitor = await screen('monitor', [source.id], false, staff ? { staffSignIn: true } : {});
  const event = row(source.id, refusal);
  await publish(event);
  return (await hub().snapshot(monitor.attachment)).rows.find((item) => item.id === event.id);
}

describe('live rejection reason', () => {
  it('reaches a monitor reading with a desk role', async () => {
    expect(await seen('desk')).toMatchObject({ kind: 'refused', reason: 'not_found' });
  });

  it('is left off for a door role and for a staffless source', async () => {
    for (const role of ['door', null] as const) {
      const shown = await seen(role);
      expect(shown).toMatchObject({ kind: 'refused' });
      expect(shown?.reason).toBeUndefined();
    }
  });
});
