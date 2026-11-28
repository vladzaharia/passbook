import { describe, expect, it } from 'vitest';
import { grant } from '../../platform/authority.ts';
import { setupGrant } from '../../platform/authority-test-fixtures.ts';
import { loadKekRing } from '../../platform/crypto.ts';
import { first, run } from '../../platform/db.ts';
import { recordPassEvent } from '../events/record.ts';
import { buildEnvelope } from './payload.ts';
import {
  deleteEndpoint,
  getEndpoint,
  insertEndpoint,
  listEndpoints,
  updateEndpoint,
} from './repo-endpoints.ts';
import { feedHead, getFeedEvent, listFeed } from './repo-feed.ts';
import { activeSecrets, insertSecret, rotateSecret } from './repo-secrets.ts';
import { newEndpointSecret, openSecret, sealSecret } from './secrets.ts';

async function setup(label: string) {
  const t = await setupGrant(label);
  const fence = { orgId: t.s.org.id, mode: 'live' as const };
  const g = (action: string) =>
    grant(t.route, {
      purpose: `org_mode.webhooks.${action}`,
      principal: t.member(),
      tables: ['webhook_endpoints', 'webhook_endpoint_secrets'],
    });
  return { ...t, fence, g, db: t.s.f.env.DB };
}

const NEW = {
  url: 'https://hooks.example.com/abc/wxyz',
  description: 'Door',
  eventTypes: ['pass.issued', 'pass.scanned'],
  templateIds: null,
  apiVersion: '2026-11-20' as const,
  createdBy: null,
  now: 1000,
};

describe('endpoint repo', () => {
  it('creates, reads, updates and deletes through a grant, fenced by org and mode', async () => {
    const t = await setup('wh-ep');
    const create = t.g('endpoint.create');
    insertEndpoint(create, { ...NEW, id: 'ep1' });
    await create.commit();
    const got = await getEndpoint(t.db, t.fence, 'ep1');
    expect(got).toMatchObject({
      orgId: t.fence.orgId,
      mode: 'live',
      url: NEW.url,
      eventTypes: NEW.eventTypes,
      templateIds: null,
      status: 'active',
      consecutiveFailures: 0,
    });
    expect(await getEndpoint(t.db, { ...t.fence, mode: 'test' }, 'ep1')).toBeNull();
    expect(await getEndpoint(t.db, { ...t.fence, orgId: 'other' }, 'ep1')).toBeNull();
    expect((await listEndpoints(t.db, t.fence)).map((e) => e.id)).toEqual(['ep1']);
    expect(await listEndpoints(t.db, { ...t.fence, orgId: 'other' })).toEqual([]);

    const update = t.g('endpoint.update');
    updateEndpoint(
      update,
      'ep1',
      { eventTypes: ['pass.voided'], templateIds: ['t1'], status: 'paused' },
      2000,
    );
    await update.commit();
    expect(await getEndpoint(t.db, t.fence, 'ep1')).toMatchObject({
      eventTypes: ['pass.voided'],
      templateIds: ['t1'],
      status: 'paused',
      updatedAt: 2000,
    });

    const resume = t.g('endpoint.update');
    updateEndpoint(resume, 'ep1', { status: 'active' }, 3000);
    await resume.commit();
    expect((await getEndpoint(t.db, t.fence, 'ep1'))?.status).toBe('active');

    const del = t.g('endpoint.delete');
    deleteEndpoint(del, 'ep1');
    await del.commit();
    expect(await getEndpoint(t.db, t.fence, 'ep1')).toBeNull();
  });

  it('a grant of one org cannot update or delete an endpoint of another (the batch aborts)', async () => {
    const a = await setup('wh-a');
    const b = await setup('wh-b');
    const create = b.g('endpoint.create');
    insertEndpoint(create, { ...NEW, id: 'epb' });
    await create.commit();
    // `require: 'one'`: the batch aborts, so no audit row can name the foreign endpoint.
    const attack = a.g('endpoint.update');
    updateEndpoint(attack, 'epb', { url: 'https://evil.example.com/x' }, 5);
    await expect(attack.commit()).rejects.toThrow();
    const del = a.g('endpoint.delete');
    deleteEndpoint(del, 'epb');
    await expect(del.commit()).rejects.toThrow();
    expect((await getEndpoint(b.db, b.fence, 'epb'))?.url).toBe(NEW.url);
  });

  it('the 101st endpoint aborts the batch', async () => {
    const t = await setup('wh-cap');
    for (let i = 0; i < 100; i++) {
      const g = t.g('endpoint.create');
      insertEndpoint(g, { ...NEW, id: `cap${i}` });
      await g.commit();
    }
    const g = t.g('endpoint.create');
    insertEndpoint(g, { ...NEW, id: 'cap100' });
    await expect(g.commit()).rejects.toThrow(/webhook endpoint limit/);
  });
});

describe('grant scope', () => {
  it('refuses a grant that is not org_mode', async () => {
    const t = await setup('wh-scope');
    const g = grant(t.route, {
      purpose: 'org.webhooks.endpoint.create',
      principal: t.member(),
      tables: ['webhook_endpoints', 'webhook_endpoint_secrets'],
    });
    expect(() => insertEndpoint(g, { ...NEW, id: 'scope1' })).toThrow(/org_mode grant/);
    expect(() => updateEndpoint(g, 'scope1', {}, 1)).toThrow(/org_mode grant/);
    expect(() => deleteEndpoint(g, 'scope1')).toThrow(/org_mode grant/);
  });
});

describe('secret repo', () => {
  it('rotates with an overlap, and expiries only move earlier', async () => {
    const t = await setup('wh-sec');
    const ring = await loadKekRing(t.s.f.env);
    const create = t.g('endpoint.create');
    insertEndpoint(create, { ...NEW, id: 'ep1' });
    await create.commit();
    const bind = (secretId: string) => ({
      secretId,
      orgId: t.fence.orgId,
      endpointId: 'ep1',
      mode: 'live' as const,
    });
    const rotate = async (id: string, now: number, overlapMs: number) => {
      const g = t.g('secret.rotate');
      rotateSecret(g, {
        id,
        endpointId: 'ep1',
        envelope: await sealSecret(ring, `whsec_${id}`, bind(id)),
        now,
        overlapMs,
      });
      await g.commit();
    };
    await rotate('s1', 1000, 0);
    await rotate('s2', 2000, 5000);
    await rotate('s3', 3000, 5000);
    const at = async (now: number) =>
      (await activeSecrets(t.db, t.fence, 'ep1', now)).map((s) => s.id);
    // s2 rotated s1 out with a 5 s overlap (to 7000); s3 cut s1 to 3000 and gave s2 until 8000.
    expect(await at(2500)).toEqual(['s3', 's2', 's1']);
    expect(await at(3500)).toEqual(['s3', 's2']);
    expect(await at(8500)).toEqual(['s3']);
    const rows = await activeSecrets(t.db, t.fence, 'ep1', 8500);
    expect(await openSecret(ring, rows[0]?.envelope as never, bind('s3'))).toBe('whsec_s3');
    // Fenced by org and mode.
    expect(await activeSecrets(t.db, { ...t.fence, orgId: 'other' }, 'ep1', 8500)).toEqual([]);
    expect(await activeSecrets(t.db, { ...t.fence, mode: 'test' }, 'ep1', 8500)).toEqual([]);
  });

  it('a secret copied to another endpoint fails to decrypt', async () => {
    const t = await setup('wh-aad');
    const ring = await loadKekRing(t.s.f.env);
    const bind = (endpointId: string, mode: 'live' | 'test' = 'live') => ({
      secretId: 's1',
      orgId: t.fence.orgId,
      endpointId,
      mode,
    });
    const envelope = await sealSecret(ring, newEndpointSecret(t.ctx), bind('ep1'));
    expect(await openSecret(ring, envelope, bind('ep1'))).toMatch(/^whsec_/);
    await expect(openSecret(ring, envelope, bind('ep2'))).rejects.toThrow();
    await expect(openSecret(ring, envelope, bind('ep1', 'test'))).rejects.toThrow();
  });

  it('a rotation of a foreign endpoint aborts instead of returning an unstored secret', async () => {
    const a = await setup('wh-s-a');
    const b = await setup('wh-s-b');
    const create = b.g('endpoint.create');
    insertEndpoint(create, { ...NEW, id: 'epb2' });
    await create.commit();
    const ring = await loadKekRing(a.s.f.env);
    const envelope = await sealSecret(ring, 'v', {
      secretId: 'x',
      orgId: a.fence.orgId,
      endpointId: 'epb2',
      mode: 'live',
    });
    const g = a.g('secret.rotate');
    rotateSecret(g, { id: 'x', endpointId: 'epb2', envelope, now: 1, overlapMs: 0 });
    await expect(g.commit()).rejects.toThrow();
    expect(await first(a.db, "SELECT 1 FROM webhook_endpoint_secrets WHERE id = 'x'")).toBeNull();
    // A bare insert is still inert for a foreign endpoint.
    const bare = a.g('secret.rotate');
    insertSecret(bare, { id: 'y', endpointId: 'epb2', envelope, now: 1 });
    await bare.commit();
    expect(await first(a.db, "SELECT 1 FROM webhook_endpoint_secrets WHERE id = 'y'")).toBeNull();
  });
});

describe('feed repo', () => {
  it('pages ascending by seq, filters, and is fenced by org and mode', async () => {
    const t = await setup('wh-feed');
    const other = await setup('wh-feed-other');
    const rec = (passId: string, orgId: string, kind: 'pass.voided' | 'pass.unvoided') =>
      recordPassEvent(t.ctx, { orgId, passId, mode: 'live', kind });
    for (const kind of ['pass.voided', 'pass.unvoided', 'pass.voided'] as const)
      await rec(t.s.pass.id, t.fence.orgId, kind);
    await rec(other.s.pass.id, other.fence.orgId, 'pass.voided');

    const page1 = await listFeed(t.db, t.fence, { after: 0, limit: 2 });
    expect(page1.rows.map((r) => r.type)).toEqual(['pass.voided', 'pass.unvoided']);
    expect(page1.hasMore).toBe(true);
    const seqs = page1.rows.map((r) => r.seq);
    expect(seqs[0]).toBeLessThan(seqs[1] ?? 0);
    const page2 = await listFeed(t.db, t.fence, { after: seqs[1] ?? 0, limit: 2 });
    expect(page2.rows.map((r) => r.type)).toEqual(['pass.voided']);
    expect(page2.hasMore).toBe(false);
    const tail = await listFeed(t.db, t.fence, { after: page2.rows[0]?.seq ?? 0, limit: 2 });
    expect(tail.rows).toEqual([]);

    expect(
      (await listFeed(t.db, t.fence, { after: 0, types: ['pass.unvoided'], limit: 10 })).rows,
    ).toHaveLength(1);
    expect((await listFeed(t.db, t.fence, { after: 0, passId: 'nope', limit: 10 })).rows).toEqual(
      [],
    );
    expect(
      (await listFeed(t.db, { ...t.fence, mode: 'test' }, { after: 0, limit: 10 })).rows,
    ).toEqual([]);
    expect(
      (await listFeed(t.db, t.fence, { after: 0, limit: 50 })).rows.every(
        (r) => r.orgId === t.fence.orgId,
      ),
    ).toBe(true);

    const head = await feedHead(t.db, t.fence);
    expect(head).toBe(page2.rows[0]?.seq);
    expect(await feedHead(t.db, { ...t.fence, orgId: 'none' })).toBe(0);
  });

  it('hides quarantined passes and fences a single event by org', async () => {
    const t = await setup('wh-feed-q');
    await recordPassEvent(t.ctx, {
      orgId: t.fence.orgId,
      passId: t.s.pass.id,
      mode: 'live',
      kind: 'pass.voided',
    });
    const [row] = (await listFeed(t.db, t.fence, { after: 0, limit: 5 })).rows;
    expect(row).toBeDefined();
    expect(await getFeedEvent(t.db, t.fence, row?.eventId ?? '')).not.toBeNull();
    expect(await getFeedEvent(t.db, { ...t.fence, orgId: 'other' }, row?.eventId ?? '')).toBeNull();
    await run(t.db, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [t.s.pass.id]);
    expect((await listFeed(t.db, t.fence, { after: 0, limit: 5 })).rows).toEqual([]);
    expect(await getFeedEvent(t.db, t.fence, row?.eventId ?? '')).toBeNull();
    expect(buildEnvelope(row as never).type).toBe('pass.voided');
  });
});
