import { beforeEach, describe, expect, it } from 'vitest';
import { getConnection } from './repo.ts';
import { createDemo, type Kit, makeKit } from './test-kit.ts';

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit();
});

async function stored(id: string) {
  const row = await getConnection(kit.env.DB, id);
  if (!row) throw new Error('missing connection');
  return row.config as Record<string, unknown>;
}

describe('prepareConfig at create', () => {
  it('stamps a Demo v2 anchor from the clock', async () => {
    const created = await createDemo(kit, { config: { dataset: 'gym-members', count: 3 } });
    const anchor = new Date(kit.clock.now()).toISOString().slice(0, 10);
    expect((await stored(created.id)).anchor).toBe(anchor);
  });

  it('keeps an anchor the caller set, and leaves classic configs as they were', async () => {
    const set = await createDemo(kit, {
      config: { dataset: 'bookings', anchor: '2030-01-02', count: 3 },
    });
    expect((await stored(set.id)).anchor).toBe('2030-01-02');
    const classic = await createDemo(kit);
    expect((await stored(classic.id)).anchor).toBeUndefined();
  });
});
