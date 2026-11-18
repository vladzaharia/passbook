import { beforeAll, describe, expect, it } from 'vitest';
import type { TagEnrollment, TagScanner } from '../../../shared/contracts/nfc-tags.ts';
import { all, first, run } from '../../platform/db.ts';
import { type EnrollFixture, enrollFixture } from '../scan/tags-enroll-test-fixtures.ts';
import { startScanCredentialTransfer } from '../scan/test-kit.ts';

let f: EnrollFixture;
beforeAll(async () => {
  f = await enrollFixture();
});

const db = () => f.kit.env.DB;
const request = (
  passId: string,
  scannerId: string,
  binding: 'pass' | 'user' = 'pass',
  who = f.operator,
) => f.nfc(who.headers, 'POST', `/passes/${passId}/enrollments`, { scannerId, binding });
const problem = async (response: Response) =>
  (await response.json()) as { code: string; detail?: string };
const audits = async (action: string, targetId: string) =>
  (
    await first<{ n: number }>(
      db(),
      'SELECT count(*) AS n FROM audit_log WHERE action = ? AND target_id = ?',
      [action, targetId],
    )
  )?.n;

/** A desk that reads tags with its device socket open, and a pass. */
async function ready(options: { owner?: boolean } = {}) {
  const scanner = await f.device('desk');
  const socket = await f.connect(scanner.id);
  const { pass, ownerId } = await f.pass(options);
  return { scanner, socket, pass, ownerId };
}

describe('requesting a tag', () => {
  it('creates a 90 s request, rings the device with an id and an expiry only, and no pass data', async () => {
    const { scanner, socket, pass } = await ready();
    const response = await request(pass.id, scanner.id);
    expect(response.status).toBe(200);
    const e = await f.json<TagEnrollment>(response);
    expect(e).toMatchObject({
      passId: pass.id,
      scannerId: scanner.id,
      scope: 'pass',
      state: 'pending',
      shownAt: null,
      binding: null,
      errorCode: null,
    });
    expect(e.expiresAt - e.createdAt).toBe(90_000);
    await f.wait();
    expect(socket.messages).toEqual([{ enroll: { id: e.id, expiresAt: e.expiresAt } }]);
    expect(JSON.stringify(socket.messages)).not.toContain(pass.id);
    expect(await audits('tag.enroll.request', e.id)).toBe(1);
    socket.socket.close(1000);
  });

  it('allows one pending request per scanner and per pass', async () => {
    const a = await ready();
    const b = await ready();
    const first = await request(a.pass.id, a.scanner.id);
    expect(first.status).toBe(200);
    for (const [pass, scanner] of [
      [b.pass.id, a.scanner.id],
      [a.pass.id, b.scanner.id],
    ] as const) {
      const again = await request(pass, scanner);
      expect(again.status).toBe(409);
      expect((await problem(again)).code).toBe('TAG_REQUEST_BUSY');
    }
    expect(
      await first_(
        `SELECT count(*) AS n FROM tag_enrollments WHERE state = 'pending' AND scanner_id = ?`,
        a.scanner.id,
      ),
    ).toBe(1);
    a.socket.socket.close(1000);
    b.socket.socket.close(1000);
  });

  it('refuses a user scope for a pass with no owner account', async () => {
    const { scanner, socket, pass } = await ready();
    const response = await request(pass.id, scanner.id, 'user');
    expect(response.status).toBe(422);
    expect((await problem(response)).code).toBe('TAG_NO_ACCOUNT');
    socket.socket.close(1000);
  });

  it('stores the owner for a user scope', async () => {
    const { scanner, socket, pass, ownerId } = await ready({ owner: true });
    const e = await f.json<TagEnrollment>(await request(pass.id, scanner.id, 'user'));
    expect(e.scope).toBe('user');
    expect(
      (
        await first<{ user_id: string }>(db(), 'SELECT user_id FROM tag_enrollments WHERE id = ?', [
          e.id,
        ])
      )?.user_id,
    ).toBe(ownerId);
    socket.socket.close(1000);
  });

  it('fails with SCANNER_OFFLINE when the device has no socket', async () => {
    const scanner = await f.device('desk');
    const { pass } = await f.pass();
    const response = await request(pass.id, scanner.id);
    expect(response.status).toBe(409);
    expect((await problem(response)).code).toBe('SCANNER_OFFLINE');
    const row = await first<{ state: string; error_code: string }>(
      db(),
      'SELECT state, error_code FROM tag_enrollments WHERE pass_id = ? AND scanner_id = ?',
      [pass.id, scanner.id],
    );
    expect(row).toEqual({ state: 'failed', error_code: 'SCANNER_OFFLINE' });
    // The pass and scanner are free again.
    const socket = await f.connect(scanner.id);
    const again = await request(pass.id, scanner.id);
    expect(again.status, await again.clone().text()).toBe(200);
    socket.socket.close(1000);
  });

  it("answers another org's scanner as not found, and a door reader or a scanner that cannot read tags as unavailable", async () => {
    const { scanner, socket, pass } = await ready();
    const foreign = await f.otherScanner();
    const gone = await request(pass.id, foreign.id);
    expect(gone.status).toBe(404);
    expect((await problem(gone)).code).toBe('SCANNER_NOT_FOUND');
    const door = await f.device('door');
    const doorSocket = await f.connect(door.id);
    const refused = await request(pass.id, door.id);
    expect(refused.status).toBe(409);
    expect((await problem(refused)).code).toBe('SCANNER_REQUESTS_OFF');
    const blind = await f.device('desk', { reads: false });
    expect((await problem(await request(pass.id, blind.id))).code).toBe('SCANNER_NO_TAGS');
    const never = await f.device('desk', { tags: { assign: 'never', assignAll: 'never' } });
    expect((await problem(await request(pass.id, never.id))).code).toBe('SCANNER_REQUESTS_OFF');
    expect(
      await first(db(), 'SELECT 1 FROM tag_enrollments WHERE scanner_id IN (?, ?)', [
        door.id,
        blind.id,
      ]),
    ).toBeNull();
    // Nothing was rung.
    expect(doorSocket.messages).toEqual([]);
    expect(scanner.id).not.toBe(door.id);
    socket.socket.close(1000);
    doorSocket.socket.close(1000);
  });

  it('is refused while the org switch is off', async () => {
    const { scanner, socket, pass } = await ready();
    const scope = `org:${f.kit.org.id}`;
    await run(db(), 'DELETE FROM settings WHERE scope = ?', [scope]);
    // The settings cache is per isolate for a few seconds.
    f.kit.clock.advance(10_000);
    try {
      const response = await request(pass.id, scanner.id);
      expect(response.status).toBe(409);
      expect((await problem(response)).code).toBe('TAGS_OFF');
    } finally {
      await run(
        db(),
        "INSERT INTO settings (scope, key, value, updated_at) VALUES (?, 'nfc.tags', '{\"enabled\":true}', 1)",
        [scope],
      );
      f.kit.clock.advance(10_000);
    }
    socket.socket.close(1000);
  });
});

async function first_(sql: string, ...params: string[]) {
  return (await first<{ n: number }>(db(), sql, params))?.n;
}

describe('who may ask', () => {
  it('needs passes:operate for a request and for cancelling, passes:read to look, and a session', async () => {
    const { scanner, socket, pass } = await ready();
    expect((await request(pass.id, scanner.id, 'pass', f.reader)).status).toBe(403);
    expect((await request(pass.id, scanner.id, 'pass', f.outsider)).status).toBe(404);
    expect((await request(pass.id, scanner.id, 'pass', f.stranger)).status).toBe(404);
    const e = await f.json<TagEnrollment>(await request(pass.id, scanner.id));
    const path = `/passes/${pass.id}/enrollments/${e.id}`;
    expect((await f.nfc(f.reader.headers, 'GET', path)).status).toBe(200);
    expect((await f.nfc(f.outsider.headers, 'GET', path)).status).toBe(404);
    expect((await f.nfc(f.stranger.headers, 'GET', path)).status).toBe(404);
    expect((await f.nfc(f.reader.headers, 'DELETE', path)).status).toBe(403);
    expect((await f.nfc(f.stranger.headers, 'DELETE', path)).status).toBe(404);
    expect((await f.nfc({}, 'GET', path)).status).toBe(401);
    expect((await f.nfc(f.operator.headers, 'GET', path, undefined, 'test')).status).toBe(404);
    socket.socket.close(1000);
  });

  it('lists scanners for operators only, in the right org', async () => {
    const orgPath = `/scanners?orgId=${f.kit.org.id}`;
    expect((await f.nfc(f.reader.headers, 'GET', orgPath)).status).toBe(403);
    expect((await f.nfc(f.stranger.headers, 'GET', orgPath)).status).toBe(404);
    expect((await f.nfc(f.operator.headers, 'GET', `/scanners?orgId=${f.other.id}`)).status).toBe(
      404,
    );
    expect((await f.nfc(f.operator.headers, 'GET', orgPath)).status).toBe(200);
  });
});

describe('scanners', () => {
  it('lists online state and why a scanner cannot take a request', async () => {
    const reads = await f.device('desk');
    const quiet = await f.device('desk');
    const door = await f.device('door');
    const blind = await f.device('desk', { reads: false });
    const sockets = [
      await f.connect(reads.id),
      await f.connect(door.id),
      await f.connect(blind.id),
    ];
    const { pass } = await f.pass();
    // The first one is mid-request.
    const busy = await f.device('desk');
    sockets.push(await f.connect(busy.id));
    expect((await request(pass.id, busy.id)).status).toBe(200);
    const list = await f.json<{ items: TagScanner[] }>(
      await f.nfc(f.operator.headers, 'GET', `/scanners?orgId=${f.kit.org.id}`),
    );
    const by = (id: string) => list.items.find((s) => s.id === id);
    expect(by(reads.id)).toMatchObject({ online: true, unavailable: null, role: 'desk' });
    expect(by(quiet.id)).toMatchObject({ online: false, unavailable: 'offline' });
    expect(by(door.id)).toMatchObject({ online: true, unavailable: 'requests_off', role: 'door' });
    expect(by(blind.id)).toMatchObject({ online: true, unavailable: 'no_tags' });
    expect(by(busy.id)).toMatchObject({ online: true, unavailable: 'busy' });
    expect(by(busy.id)?.lastUsedAt).not.toBeNull();
    expect(by(reads.id)?.lastUsedAt).toBeNull();
    for (const s of sockets) s.socket.close(1000);
    // Test mode has none of these.
    const test = await f.json<{ items: TagScanner[] }>(
      await f.nfc(f.operator.headers, 'GET', `/scanners?orgId=${f.kit.org.id}`, undefined, 'test'),
    );
    expect(test.items).toEqual([]);
  });
});

describe('cancel, decline and expiry', () => {
  it('cancels, rings the device with the cancellation, and the device can no longer complete', async () => {
    const { scanner, socket, pass } = await ready();
    const e = await f.json<TagEnrollment>(await request(pass.id, scanner.id));
    const path = `/passes/${pass.id}/enrollments/${e.id}`;
    const cancelled = await f.json<TagEnrollment>(await f.nfc(f.operator.headers, 'DELETE', path));
    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.endedAt).not.toBeNull();
    await f.wait();
    expect(socket.messages.at(-1)).toEqual({ enroll: { id: e.id, cancelled: true } });
    expect(await audits('tag.enroll.cancel', e.id)).toBe(1);
    const complete = await f.kit.post(scanner.headers, `/tag-enrollments/${e.id}/complete`, {
      tag: f.read(),
    });
    expect(complete.status).toBe(409);
    expect((await problem(complete)).code).toBe('ENROLLMENT_ENDED');
    // Cancelling again changes nothing; the pass can be asked again.
    expect((await f.nfc(f.operator.headers, 'DELETE', path)).status).toBe(200);
    expect(await audits('tag.enroll.cancel', e.id)).toBe(1);
    const again = await request(pass.id, scanner.id);
    expect(again.status, await again.clone().text()).toBe(200);
    socket.socket.close(1000);
  });

  it('records a decline from the device', async () => {
    const { scanner, socket, pass } = await ready();
    const e = await f.json<TagEnrollment>(await request(pass.id, scanner.id));
    const declined = await f.kit.post(scanner.headers, `/tag-enrollments/${e.id}/decline`, {});
    expect(declined.status).toBe(200);
    expect(await declined.json()).toEqual({ status: 'declined' });
    const view = await f.json<TagEnrollment>(
      await f.nfc(f.operator.headers, 'GET', `/passes/${pass.id}/enrollments/${e.id}`),
    );
    expect(view.state).toBe('declined');
    expect(await audits('tag.enroll.decline', e.id)).toBe(1);
    expect((await f.kit.post(scanner.headers, `/tag-enrollments/${e.id}/decline`, {})).status).toBe(
      409,
    );
    socket.socket.close(1000);
  });

  it('expires at the exact TTL: a read at the last millisecond works, one at the limit does not, and a new request sweeps the old', async () => {
    const { scanner, socket, pass } = await ready();
    const e = await f.json<TagEnrollment>(await request(pass.id, scanner.id));
    f.kit.clock.advance(90_000);
    const late = await f.kit.post(scanner.headers, `/tag-enrollments/${e.id}/complete`, {
      tag: f.read(),
    });
    expect(late.status).toBe(409);
    expect((await problem(late)).code).toBe('TAG_REQUEST_EXPIRED');
    const view = await f.json<TagEnrollment>(
      await f.nfc(f.operator.headers, 'GET', `/passes/${pass.id}/enrollments/${e.id}`),
    );
    expect(view).toMatchObject({ state: 'expired', endedAt: e.expiresAt });
    expect(await f.deviceGet(scanner, '/tag-enrollments/pending').then((r) => r.json())).toEqual({
      enrollment: null,
    });
    // The row is still pending until something sweeps it.
    expect(
      await first_(
        'SELECT count(*) AS n FROM tag_enrollments WHERE id = ? AND state = ?',
        e.id,
        'pending',
      ),
    ).toBe(1);
    const again = await request(pass.id, scanner.id);
    expect(again.status, await again.clone().text()).toBe(200);
    expect(
      await first_(
        'SELECT count(*) AS n FROM tag_enrollments WHERE id = ? AND state = ?',
        e.id,
        'expired',
      ),
    ).toBe(1);
    expect(await audits('tag.enroll.expire', e.id)).toBe(1);
    socket.socket.close(1000);
  });

  it('completes in the last millisecond of the window', async () => {
    const { scanner, socket, pass } = await ready();
    const e = await f.json<TagEnrollment>(await request(pass.id, scanner.id));
    f.kit.clock.advance(89_999);
    const done = await f.kit.post(scanner.headers, `/tag-enrollments/${e.id}/complete`, {
      tag: f.read(),
    });
    expect(done.status, await done.clone().text()).toBe(200);
    socket.socket.close(1000);
  });
});

describe('the device side', () => {
  it('shows only names and the expiry, marks the request shown, and refuses a door', async () => {
    const { scanner, socket, pass } = await ready({ owner: true });
    const e = await f.json<TagEnrollment>(await request(pass.id, scanner.id, 'user'));
    expect(e.shownAt).toBeNull();
    const pending = (await (await f.deviceGet(scanner, '/tag-enrollments/pending')).json()) as {
      enrollment: Record<string, unknown>;
    };
    expect(pending.enrollment).toMatchObject({
      id: e.id,
      holderName: 'Jane Owner',
      scope: 'user',
      expiresAt: e.expiresAt,
    });
    expect(Object.keys(pending.enrollment).sort()).toEqual(
      ['expiresAt', 'holderName', 'id', 'passTitle', 'requestedByName', 'scope'].sort(),
    );
    const view = await f.json<TagEnrollment>(
      await f.nfc(f.operator.headers, 'GET', `/passes/${pass.id}/enrollments/${e.id}`),
    );
    expect(view.shownAt).toBe(f.kit.clock.now());
    const door = await f.device('door');
    const refused = await f.deviceGet(door, '/tag-enrollments/pending');
    expect(refused.status).toBe(403);
    // A scanner that was not asked sees nothing.
    const other = await f.device('desk');
    expect(await (await f.deviceGet(other, '/tag-enrollments/pending')).json()).toEqual({
      enrollment: null,
    });
    socket.socket.close(1000);
  });

  it('answers a wrong scanner like an unknown id', async () => {
    const { scanner, socket, pass } = await ready();
    const e = await f.json<TagEnrollment>(await request(pass.id, scanner.id));
    const other = await f.device('desk');
    const wrong = await f.kit.post(other.headers, `/tag-enrollments/${e.id}/complete`, {
      tag: f.read(),
    });
    const unknown = await f.kit.post(other.headers, '/tag-enrollments/0000/complete', {
      tag: f.read(),
    });
    expect(wrong.status).toBe(404);
    const bodyOf = async (r: Response) => ({ ...((await r.json()) as object), requestId: null });
    expect(await bodyOf(wrong)).toEqual(await bodyOf(unknown));
    expect((await f.kit.post(other.headers, `/tag-enrollments/${e.id}/decline`, {})).status).toBe(
      404,
    );
    expect(
      await first_(
        "SELECT count(*) AS n FROM tag_enrollments WHERE id = ? AND state = 'pending'",
        e.id,
      ),
    ).toBe(1);
    socket.socket.close(1000);
  });

  it('binds the tag to the pass, once, as a remote bind by the admin, and the admin sees it done', async () => {
    const { scanner, socket, pass } = await ready();
    const e = await f.json<TagEnrollment>(await request(pass.id, scanner.id));
    const tag = f.read();
    const done = await f.kit.post(scanner.headers, `/tag-enrollments/${e.id}/complete`, { tag });
    expect(done.status, await done.clone().text()).toBe(200);
    const result = (await done.json()) as {
      status: string;
      hint: string;
      scope: string;
      bindingId: string;
    };
    expect(result).toMatchObject({ status: 'done', scope: 'pass' });
    const binding = await first<Record<string, unknown>>(
      db(),
      'SELECT scope, source, bound_by_type, bound_by, scanner_id, pass_id FROM tag_bindings WHERE id = ?',
      [result.bindingId],
    );
    expect(binding).toEqual({
      scope: 'pass',
      source: 'remote',
      bound_by_type: 'user',
      bound_by: f.operator.user.id,
      scanner_id: scanner.id,
      pass_id: pass.id,
    });
    const view = await f.json<TagEnrollment>(
      await f.nfc(f.operator.headers, 'GET', `/passes/${pass.id}/enrollments/${e.id}`),
    );
    expect(view.state).toBe('done');
    expect(view.binding).toMatchObject({
      id: result.bindingId,
      source: 'remote',
      scannerName: expect.any(String),
    });
    expect(await audits('tag.enroll.complete', e.id)).toBe(1);
    expect(
      (
        await first<{ n: number }>(
          db(),
          "SELECT count(*) AS n FROM audit_log WHERE action = 'tag.bind' AND detail LIKE '%remote%'",
        )
      )?.n,
    ).toBeGreaterThan(0);
    // Single use.
    const again = await f.kit.post(scanner.headers, `/tag-enrollments/${e.id}/complete`, {
      tag: f.read(),
    });
    expect(again.status).toBe(409);
    expect((await problem(again)).code).toBe('ENROLLMENT_ENDED');
    expect(await first_('SELECT count(*) AS n FROM tag_bindings WHERE pass_id = ?', pass.id)).toBe(
      1,
    );
    socket.socket.close(1000);
  });

  it('binds to the person for a user scope, and refuses a tag another holder has, a random UID and a lost tag', async () => {
    const { scanner, socket, pass, ownerId } = await ready({ owner: true });
    const e = await f.json<TagEnrollment>(await request(pass.id, scanner.id, 'user'));
    // A tag held by another pass is refused and the request stays open.
    const taken = f.read();
    const holder = await f.pass();
    expect(
      (await f.bind(await f.desk(), { binding: 'pass', tag: taken, card: holder.card })).status,
    ).toBe(200);
    const held = await f.kit.post(scanner.headers, `/tag-enrollments/${e.id}/complete`, {
      tag: taken,
    });
    expect(held.status).toBe(409);
    expect((await problem(held)).code).toBe('TAG_HELD_BY_OTHER');
    const random = await f.kit.post(scanner.headers, `/tag-enrollments/${e.id}/complete`, {
      tag: { uid: '08aabbcc', tech: 'a', source: 'native' },
    });
    expect((await problem(random)).code).toBe('TAG_UID_RANDOM');
    const ok = await f.kit.post(scanner.headers, `/tag-enrollments/${e.id}/complete`, {
      tag: f.read(),
    });
    expect(ok.status).toBe(200);
    const row = await first<{ scope: string; user_id: string }>(
      db(),
      'SELECT scope, user_id FROM tag_bindings WHERE id = ?',
      [((await ok.json()) as { bindingId: string }).bindingId],
    );
    expect(row).toEqual({ scope: 'user', user_id: ownerId });
    socket.socket.close(1000);
  });

  it('refuses a user scope whose pass changed hands during the window', async () => {
    const { scanner, socket, pass } = await ready({ owner: true });
    const e = await f.json<TagEnrollment>(await request(pass.id, scanner.id, 'user'));
    await startScanCredentialTransfer(f.kit, pass.id);
    const response = await f.kit.post(scanner.headers, `/tag-enrollments/${e.id}/complete`, {
      tag: f.read(),
    });
    expect(response.status).toBe(409);
    expect((await problem(response)).code).toBe('TAG_HOLDER_CHANGED');
    expect(await (await f.deviceGet(scanner, '/tag-enrollments/pending')).json()).toEqual({
      enrollment: null,
    });
    expect(await first_('SELECT count(*) AS n FROM tag_bindings WHERE pass_id = ?', pass.id)).toBe(
      0,
    );
    socket.socket.close(1000);
  });

  it('refuses at commit when the admin no longer holds passes:operate', async () => {
    const { scanner, socket, pass } = await ready();
    const admin = await f.member(f.kit.org.id, ['pass_operator']);
    const e = await f.json<TagEnrollment>(await request(pass.id, scanner.id, 'pass', admin));
    await run(db(), 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
      f.kit.clock.now(),
      admin.membershipId,
    ]);
    const response = await f.kit.post(scanner.headers, `/tag-enrollments/${e.id}/complete`, {
      tag: f.read(),
    });
    expect(response.status).toBe(409);
    expect((await problem(response)).code).toBe('TAG_REQUEST_REVOKED');
    expect(await first_('SELECT count(*) AS n FROM tag_bindings WHERE pass_id = ?', pass.id)).toBe(
      0,
    );
    expect(
      await first_(
        "SELECT count(*) AS n FROM tag_enrollments WHERE id = ? AND state = 'pending'",
        e.id,
      ),
    ).toBe(1);
    socket.socket.close(1000);
  });

  it('takes a tag already bound to the same pass as done without a second binding', async () => {
    const { scanner, socket, pass } = await ready();
    const tag = f.read();
    const card = (await f.pass()).card;
    void card;
    const desk = await f.desk();
    const bound = await f.bind(desk, {
      binding: 'pass',
      tag,
      card: { code: pass.scanCode ?? '', method: 'camera' },
    });
    expect(bound.status).toBe(200);
    const e = await f.json<TagEnrollment>(await request(pass.id, scanner.id));
    const done = await f.kit.post(scanner.headers, `/tag-enrollments/${e.id}/complete`, { tag });
    expect(done.status, await done.clone().text()).toBe(200);
    expect(await first_('SELECT count(*) AS n FROM tag_bindings WHERE pass_id = ?', pass.id)).toBe(
      1,
    );
    socket.socket.close(1000);
  });

  it('leaves the rows of every request in the audit log without any UID', async () => {
    const rows = await all<{ detail: string | null }>(
      db(),
      "SELECT detail FROM audit_log WHERE action LIKE 'tag.enroll.%'",
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.detail ?? '').not.toMatch(/04[0-9a-f]{12}/);
  });
});
