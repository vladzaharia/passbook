import { describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { targetFilter } from './apply.ts';
import { countTarget, targetPage } from './repo-target.ts';
import { broadcastKit } from './test-kit.ts';

describe('broadcast scan targeting', () => {
  it('uses the same event and recency predicates for preview counts and execution pages', async () => {
    const kit = await broadcastKit();
    const arrived = await kit.makePass();
    const absent = await kit.makePass();
    const testPass = await kit.makePass({ mode: 'test' });
    const now = kit.clock.now();
    const eventId = 'event-target';
    for (const [pass, mode] of [
      [arrived, 'live'],
      [testPass, 'test'],
    ] as const) {
      await run(
        kit.env.DB,
        `INSERT INTO scan_gates (pass_id, action_id, scope, org_id, mode, template_id, kind, state, count, first_at, last_at, last_scan_id)
        VALUES (?, 'check_in', ?, ?, ?, ?, 'check_in', 'out', 1, ?, ?, 'scan')`,
        [pass.id, `event:${eventId}`, kit.org.id, mode, kit.messaging.id, now, now],
      );
    }
    await run(
      kit.env.DB,
      `INSERT INTO scans (id, org_id, mode, pass_id, actor_type, actor_id, actor_key, idempotency_key, request_hash, method, state, outcome, action_kind, at)
      VALUES ('recent-scan', ?, 'live', ?, 'system', 'system', 'system', 'recent', 'hash', 'manual', 'done', 'refused', 'check_in', ?)`,
      [kit.org.id, arrived.id, now],
    );
    const filter = (scan: object) =>
      targetFilter(
        {
          org_id: kit.org.id,
          mode: 'live',
          target: JSON.stringify({ templateIds: [kit.messaging.id], scan }),
        },
        null,
        100,
      );
    const assertAudience = async (scan: object, expected: string[]) => {
      const f = filter(scan);
      const counts = await countTarget(kit.env.DB, f, now, now - 86_400_000, 3);
      const page = await targetPage(kit.env.DB, f, now);
      expect(page.ids.sort()).toEqual(expected.sort());
      expect(counts.targeted).toBe(expected.length);
    };
    await assertAudience({ eventId, checkedIn: true }, [arrived.id]);
    await assertAudience({ eventId, checkedIn: false }, [absent.id]);
    await assertAudience({ noScanDays: 30 }, [absent.id]);
    await assertAudience({ noScanDays: 90 }, [absent.id]);
  });
});
