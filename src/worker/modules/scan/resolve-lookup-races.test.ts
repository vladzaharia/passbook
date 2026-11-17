import { describe, expect, it } from 'vitest';
import { stagePendingCredentialTransfer } from '../../../../test/helpers/credential-transfer.ts';
import { run } from '../../platform/db.ts';
import {
  fixture,
  kit,
  noDisclosure,
  raceFence,
  templateId,
} from './repo-output-authority-split-test-fixtures.ts';
import { key } from './test-kit.ts';

/*
 * A change that lands between a read and its answer's fence: before it, the card or the item is
 * answered (positive control); at the fence it is withheld whole. The fence is one statement joined
 * to the actor's authority, so the race has nowhere to hide: resolve at its final batch (occurrence
 * 1), lookup at its second gate (occurrence 2, after the search page).
 */

type Change = [name: string, apply: (db: D1Database, passId: string) => Promise<unknown>];

const CHANGES: Change[] = [
  [
    'pass deleted',
    (db, id) =>
      run(db, 'UPDATE passes SET deleted_at=?, revision=revision+1 WHERE id=?', [
        kit.clock.now(),
        id,
      ]),
  ],
  [
    'pass voided',
    (db, id) =>
      run(
        db,
        "UPDATE passes SET status='voided', lifecycle_generation=lifecycle_generation+1 WHERE id=?",
        [id],
      ),
  ],
  [
    'pass removed',
    (db, id) =>
      run(
        db,
        'UPDATE passes SET removed_at=?, lifecycle_generation=lifecycle_generation+1 WHERE id=?',
        [kit.clock.now(), id],
      ),
  ],
  [
    'template deleted',
    (db) => run(db, "UPDATE templates SET status='deleted' WHERE id=?", [templateId]),
  ],
  [
    'transfer pending',
    (db, id) =>
      stagePendingCredentialTransfer(db, id, {
        id: kit.fx.ids.id(),
        token: kit.fx.ids.token(),
        now: kit.clock.now(),
        targetHolderEmail: 'next@example.test',
      }),
  ],
];

const request = (route: 'resolve' | 'lookup', headers: Record<string, string>, passId: string) =>
  kit.post(
    headers,
    `/${route}`,
    route === 'resolve'
      ? { idempotencyKey: key(), input: { passId, method: 'manual' }, clientTs: kit.clock.now() }
      : { q: passId },
  );

async function raced(
  route: 'resolve' | 'lookup',
  headers: Record<string, string>,
  passId: string,
  change: () => Promise<unknown>,
) {
  const real = kit.env.DB;
  const race = raceFence(real, change, route === 'resolve' ? 1 : 2);
  Object.assign(kit.env, { DB: race.db });
  try {
    const response = await request(route, headers, passId);
    expect(race.fired()).toBe(true);
    return { status: response.status, text: await response.text() };
  } finally {
    Object.assign(kit.env, { DB: real });
  }
}

describe.each(['resolve', 'lookup'] as const)('%s: a change at the fence', (route) => {
  it.each(CHANGES)('withholds the answer when the %s', async (name, apply) => {
    // Positive control: the same request, with nothing raced, answers.
    const control = await fixture();
    const answered = await request(route, control.scanner.headers, control.pass.id);
    const body = (await answered.json()) as Record<string, any>;
    expect(route === 'resolve' ? body.card?.passId : body.items?.[0]?.passId).toBe(control.pass.id);

    const f = await fixture();
    const result = await raced(route, f.scanner.headers, f.pass.id, () =>
      apply(kit.env.DB, f.pass.id),
    );
    expect(result.status).toBe(200);
    const denied = JSON.parse(result.text) as Record<string, any>;
    if (route === 'resolve')
      expect(denied).toMatchObject({ kind: 'refused', card: null, display: null });
    else expect(denied).toEqual({ items: [], more: false });
    noDisclosure(result.text, f.pass.id);
    if (name === 'template deleted')
      await run(kit.env.DB, "UPDATE templates SET status='active' WHERE id=?", [templateId]);
  });

  it('withholds the answer when the org is suspended at the fence, and answers once restored', async () => {
    const f = await fixture();
    const result = await raced(route, f.scanner.headers, f.pass.id, () =>
      run(kit.env.DB, "UPDATE orgs SET status='suspended' WHERE id=?", [kit.org.id]),
    );
    await run(kit.env.DB, "UPDATE orgs SET status='active' WHERE id=?", [kit.org.id]);
    expect(result.status).not.toBe(500);
    expect(result.text).not.toContain(f.pass.id);
    const again = await request(route, f.scanner.headers, f.pass.id);
    expect(again.status).toBe(200);
  });

  it('withholds the answer when the scanner is reconfigured at the fence', async () => {
    const f = await fixture();
    const result = await raced(route, f.scanner.headers, f.pass.id, () =>
      run(kit.env.DB, "UPDATE scanners SET time_zone='Europe/Paris' WHERE id=?", [f.scanner.id]),
    );
    expect(result.text).not.toContain(f.pass.id);
    expect(result.text).not.toContain('member.png');
  });

  it('withholds the answer when a signed-in staff member is disabled at the fence', async () => {
    const f = await fixture();
    const staff = await kit.staff('door');
    const scanner = await kit.scanner({
      templateIds: [templateId],
      staffId: staff.id,
      settings: { staffSignIn: true },
      staffSince: kit.clock.now(),
      staffSeenAt: kit.clock.now(),
    });
    const control = await request(route, scanner.headers, f.pass.id);
    expect(control.status).toBe(200);
    const result = await raced(route, scanner.headers, f.pass.id, () =>
      run(kit.env.DB, 'UPDATE scan_staff SET disabled_at=? WHERE id=?', [
        kit.clock.now(),
        staff.id,
      ]),
    );
    expect(result.text).not.toContain(f.pass.id);
    expect(result.text).not.toContain('member.png');
  });
});
