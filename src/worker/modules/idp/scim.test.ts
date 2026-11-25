import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { bump } from '../../platform/counters.ts';
import { all } from '../../platform/db.ts';
import { SCIM_REJECTS_PER_MINUTE, SCIM_REQUESTS_PER_MINUTE } from './scim-auth.ts';
import { polarisSync, scim, scimRig, TOKEN } from './scim-test-fixtures.ts';
import { MAX_MEMBERS } from './scim-wire.ts';

const HOUR = 3_600_000;

describe('SCIM receiver: Polaris ID sync replay', () => {
  it('creates, pages, skips an older change, updates a newer one and deletes what is gone', async () => {
    const s = await scimRig();
    // The owner's last change is older than the first push, as it is when Polaris ID has settled.
    const t0 = s.r.f.clock.now() - 10 * 60_000;
    const local = {
      users: ['u1', 'u2', 'u3', 'u4', 'u5'].map((id) => ({ id, active: true, modified: t0 })),
      groups: [
        { id: 'g1', members: ['u1', 'u2'], modified: t0 },
        { id: 'g2', members: ['u3'], modified: t0 },
      ],
    };
    const first = await polarisSync(s, local, 2);
    expect(first).toMatchObject({ created: 7, updated: 0, deleted: 0, skipped: 0 });
    expect(first.pages).toBeGreaterThanOrEqual(2);

    // The receiver answers what it holds: ids as given, userName the subject, names and addresses gone.
    const listed = await scim(s, 'GET', '/Users?startIndex=1&count=2');
    expect(listed.status).toBe(200);
    expect(listed.headers.get('content-type')).toContain('application/scim+json');
    expect(listed.body).toMatchObject({ totalResults: 5, startIndex: 1, itemsPerPage: 2 });
    expect(listed.body.Resources[0]).toMatchObject({
      userName: listed.body.Resources[0].externalId,
      active: true,
    });
    expect(JSON.stringify(listed.body)).not.toMatch(/example\.test|Given|Family|Display/);
    const tail = await scim(s, 'GET', '/Users?startIndex=5&count=2');
    expect(tail.body.Resources).toHaveLength(1);

    // Nothing changed, an hour later: Polaris ID's changes are older than the receiver's, so it skips them all.
    s.r.f.clock.advance(HOUR);
    const idle = await polarisSync(s, local, 2);
    expect(idle).toMatchObject({ created: 0, updated: 0, deleted: 0, skipped: 7 });

    // One user and one group change after the last write; u5 leaves.
    const t1 = s.r.f.clock.now();
    local.users[1] = { id: 'u2', active: false, modified: t1 };
    local.users.pop();
    local.groups[0] = { id: 'g1', members: ['u1'], modified: t1 };
    const changed = await polarisSync(s, local, 2);
    expect(changed).toMatchObject({ created: 0, updated: 2, deleted: 1, skipped: 4 });
    const u2 = (await scim(s, 'GET', '/Users?count=10')).body.Resources.find(
      (r: { externalId: string }) => r.externalId === 'u2',
    );
    expect(u2.active).toBe(false);
    expect((await scim(s, 'GET', '/Users?count=10')).body.totalResults).toBe(4);
  });

  it('answers DELETE 204 once and 404 after, and a POST of a known subject keeps its id', async () => {
    const s = await scimRig();
    const made = await scim(s, 'POST', '/Users', { externalId: 'sub-1', active: true });
    expect(made.status).toBe(201);
    const again = await scim(s, 'POST', '/Users', { externalId: 'sub-1', active: true });
    expect(again).toMatchObject({ status: 200, body: { id: made.body.id } });
    expect((await scim(s, 'DELETE', `/Users/${made.body.id}`)).status).toBe(204);
    expect((await scim(s, 'DELETE', `/Users/${made.body.id}`)).status).toBe(404);
    expect((await scim(s, 'GET', `/Users/${made.body.id}`)).status).toBe(404);
    const back = await scim(s, 'POST', '/Users', { externalId: 'sub-1' });
    expect(back).toMatchObject({ status: 200, body: { id: made.body.id, active: true } });
  });

  it('refuses to point an id at another subject, and an unknown id', async () => {
    const s = await scimRig();
    const made = await scim(s, 'POST', '/Users', { externalId: 'sub-1' });
    expect((await scim(s, 'PUT', `/Users/${made.body.id}`, { externalId: 'sub-2' })).status).toBe(
      400,
    );
    expect((await scim(s, 'PUT', '/Users/nope', { externalId: 'sub-1' })).status).toBe(404);
    const group = await scim(s, 'POST', '/Groups', { externalId: 'grp-1', members: [] });
    expect((await scim(s, 'PUT', `/Groups/${group.body.id}`, { externalId: 'grp-2' })).status).toBe(
      400,
    );
  });
});

describe('SCIM receiver: the token', () => {
  it('answers 401 for a missing, wrong, near or longer token, and 404 while the secret is unset or short', async () => {
    const s = await scimRig();
    for (const token of [
      null,
      '',
      'wrong',
      `x${TOKEN.slice(1)}`,
      `${TOKEN.slice(0, -1)}y`,
      `${TOKEN}x`,
      TOKEN.slice(0, -1),
    ])
      expect((await scim(s, 'GET', '/Users', undefined, { token })).status, String(token)).toBe(
        401,
      );
    const noScheme = await s.app.request(
      '/scim/v2/Users',
      { headers: { authorization: TOKEN } },
      s.r.f.env,
    );
    expect(noScheme.status).toBe(401);
    expect((await scim(s, 'GET', '/Users')).status).toBe(200);
    for (const secret of [undefined, 'short']) {
      Object.assign(s.r.f.env, { SCIM_BEARER_TOKEN: secret });
      expect((await scim(s, 'GET', '/Users', undefined, { token: secret ?? TOKEN })).status).toBe(
        404,
      );
    }
  });

  it('turns a prefix away without a compare once it sent too many wrong tokens', async () => {
    const s = await scimRig();
    const ip = '203.0.113.7';
    for (let i = 0; i < SCIM_REJECTS_PER_MINUTE; i++)
      expect((await scim(s, 'GET', '/Users', undefined, { token: 'bad', ip })).status).toBe(401);
    const limited = await scim(s, 'GET', '/Users', undefined, { token: TOKEN, ip });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    expect((await scim(s, 'GET', '/Users', undefined, { ip: '198.51.100.9' })).status).toBe(200);
    s.r.f.clock.advance(60_000);
    expect((await scim(s, 'GET', '/Users', undefined, { ip })).status).toBe(200);
  });

  it('limits a holder of the token to a request budget a minute', async () => {
    const s = await scimRig();
    const window = Math.floor(s.r.f.clock.now() / 60_000) * 60_000;
    await bump(env.DB, 'idp:scim:requests', window, SCIM_REQUESTS_PER_MINUTE);
    expect((await scim(s, 'GET', '/Users')).status).toBe(429);
    s.r.f.clock.advance(60_000);
    expect((await scim(s, 'GET', '/Users')).status).toBe(200);
  });
});

describe('SCIM receiver: body caps and shape', () => {
  it('refuses a user over 16 KB and a group over 256 KB, even with no content length', async () => {
    const s = await scimRig();
    const big = { externalId: 'sub-1', note: 'x'.repeat(17 * 1024) };
    expect((await scim(s, 'POST', '/Users', big)).status).toBe(413);
    const huge = { externalId: 'grp-1', members: [], note: 'x'.repeat(257 * 1024) };
    expect((await scim(s, 'POST', '/Groups', huge)).status).toBe(413);
    expect(await all(env.DB, 'SELECT scim_id FROM idp_directory_users')).toEqual([]);
  });

  it('refuses malformed JSON, bad fields and too many members without echoing the body', async () => {
    const s = await scimRig();
    const secret = 'person@example.test';
    const bad = [
      await scim(s, 'POST', '/Users', undefined, { raw: `{"externalId": "${secret}` }),
      await scim(s, 'POST', '/Users', { externalId: secret }),
      await scim(s, 'POST', '/Users', { externalId: 'sub-1', active: secret }),
      await scim(s, 'POST', '/Users', { active: true }),
      await scim(s, 'POST', '/Groups', {
        externalId: 'grp-1',
        members: Array.from({ length: MAX_MEMBERS + 1 }, (_, i) => ({ value: `m${i}` })),
      }),
    ];
    for (const reply of bad) {
      expect(reply.status).toBe(400);
      expect(JSON.stringify(reply.body)).not.toContain(secret);
    }
  });
});
