import { beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { scanningSessionsFixture } from './scanning-sessions-test-fixtures.ts';
import { key } from './test-kit.ts';

const fixture = scanningSessionsFixture();
beforeAll(fixture.setup);

describe('a passless replay stays in the session it was made in', () => {
  it('replays a miss in its own session and not once the scan belongs to another', async () => {
    const { kit, parent, device, pair, call } = fixture;
    const session = await parent('Passless replay');
    const headers = await pair((await device(session.id, 'Door')).pairing?.code ?? '');
    const request = {
      idempotencyKey: key(),
      input: { code: 'NO-SUCH-CODE', method: 'manual' as const },
      clientTs: kit.clock.now(),
      actionId: 'auto',
    };
    const first = await call('POST', '/scan/actions', request, headers);
    expect(first.status).toBe(200);
    const miss = (await first.json()) as { scanId: string };
    expect(miss).toMatchObject({ kind: 'refused', reason: 'not_found', replay: false });

    // Positive control: the same device and session replays the receipt.
    const same = await call('POST', '/scan/actions', request, headers);
    expect(await same.json()).toMatchObject({ kind: 'refused', reason: 'not_found', replay: true });

    await run(kit.env.DB, 'UPDATE scans SET session_id=? WHERE id=?', [
      'other-session',
      miss.scanId,
    ]);
    const moved = await call('POST', '/scan/actions', request, headers);
    expect(moved.status).toBe(200);
    expect(await moved.json()).toMatchObject({
      kind: 'refused',
      reason: 'not_found',
      replay: false,
    });
  });
});
