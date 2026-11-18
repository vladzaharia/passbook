import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg, makeUser, persistTemplate } from '../../../../test/helpers/index.ts';
import { makeJoinLink } from '../../../../test/helpers/join.ts';
import { all, first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { scheduleIssuanceDelivery } from '../delivery/issuance-intent.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { createPassIdempotent, createPassRow } from '../passes/create.ts';
import type { CreateParams } from '../passes/create-types.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { joinCreateGrant } from './grant.ts';
import { joinTemplate } from './join-test-fixtures.ts';

let kit: Kit;
const DAY = 86_400_000;
const D1 = 'a'.repeat(43);
const D2 = 'b'.repeat(43);
const D3 = 'c'.repeat(43);

beforeAll(async () => {
  kit = await setupKit({ template: (id) => joinTemplate(id) });
});

type Link = Awaited<ReturnType<typeof makeJoinLink>>;

async function link(
  options: {
    mode?: 'live' | 'test';
    dailyLimit?: number;
    templateId?: string;
    askEmail?: boolean;
  } = {},
) {
  const templateId = options.templateId ?? kit.template.id;
  const mode = options.mode ?? 'live';
  // One link per (org, mode, template): a test replaces the one an earlier test left.
  await run(
    kit.env.DB,
    'DELETE FROM join_links WHERE org_id = ? AND mode = ? AND template_id = ?',
    [kit.org.id, mode, templateId],
  );
  const made = await makeJoinLink(kit.fx, {
    orgId: kit.org.id,
    templateId: options.templateId ?? kit.template.id,
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.dailyLimit ? { dailyLimit: options.dailyLimit } : {}),
  });
  await run(kit.env.DB, 'UPDATE join_links SET ask_email = ? WHERE id = ?', [
    options.askEmail === false ? 0 : 1,
    made.id,
  ]);
  return made;
}

function params(
  l: Link,
  over: Partial<CreateParams> & { orgDailyCap?: number } = {},
): CreateParams {
  const mode = over.mode ?? 'live';
  const release = mode === 'live' ? kit.liveRelease : kit.testRelease;
  if (!release) throw new Error('release');
  const { orgDailyCap = 1000, ...rest } = over;
  return {
    orgId: kit.org.id,
    templateId: kit.template.id,
    templateVersion: release.version,
    input: { memberName: 'Joined Guest' },
    source: 'manual',
    mode,
    execution: { kind: 'join', linkId: l.id, generation: l.generation, orgDailyCap },
    actor: { type: 'system', id: `join:${l.id}` },
    ...rest,
  };
}

const passCount = async () =>
  (await first<{ n: number }>(kit.env.DB, 'SELECT COUNT(*) AS n FROM passes'))?.n ?? 0;
const issues = (linkId: string) =>
  all<{ pass_id: string; mode: string; org_id: string }>(
    kit.env.DB,
    'SELECT pass_id, mode, org_id FROM join_issues WHERE link_id = ?',
    [linkId],
  );
const code = async (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { code?: string }) => e.code ?? 'ERROR',
  );

describe('join create', () => {
  it('creates a pass with the ledger row, system actor join:<linkId> and no owner', async () => {
    const l = await link();
    const pass = await createPassRow(kit.ctx, params(l));
    expect(pass.ownerUserId).toBeNull();
    expect(pass.mode).toBe('live');
    expect(await issues(l.id)).toEqual([{ pass_id: pass.id, mode: 'live', org_id: kit.org.id }]);
    const audit = await all<{ actor_type: string; actor_id: string; detail: string }>(
      kit.env.DB,
      "SELECT actor_type, actor_id, detail FROM audit_log WHERE action = 'pass.create' AND target_id = ?",
      [pass.id],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_type: 'system', actor_id: `join:${l.id}` });
    expect(JSON.parse(audit[0]?.detail ?? '{}')).toEqual({
      templateId: kit.template.id,
      joinLinkId: l.id,
    });
    const event = await first<{ actor_type: string; actor_id: string; data: string }>(
      kit.env.DB,
      "SELECT actor_type, actor_id, data FROM pass_events WHERE pass_id = ? AND kind = 'pass.issued'",
      [pass.id],
    );
    expect(event).toMatchObject({ actor_type: 'system', actor_id: `join:${l.id}` });
    expect(JSON.parse(event?.data ?? '{}')).toMatchObject({ cause: 'join', source: null });
  });

  it('stores the ledger digests it is given', async () => {
    const l = await link();
    const joinKeys = { ipKey: D1, deviceKey: D2, fieldsHash: D3 };
    const pass = await createPassRow(kit.ctx, params(l, { joinKeys }));
    expect(
      await first(
        kit.env.DB,
        'SELECT ip_key, device_key, fields_hash FROM join_issues WHERE pass_id = ?',
        [pass.id],
      ),
    ).toEqual({ ip_key: D1, device_key: D2, fields_hash: D3 });
  });

  it('never sets an owner, even for an address that belongs to an account', async () => {
    const user = await makeUser(kit.fx);
    const l = await link();
    const joined = await createPassRow(kit.ctx, params(l, { holderEmail: user.primaryEmail }));
    expect(joined.ownerUserId).toBeNull();
    expect(
      await first(kit.env.DB, 'SELECT 1 AS x FROM audit_log WHERE action = ? AND target_id = ?', [
        'holder.attach',
        joined.id,
      ]),
    ).toBeNull();
    // Positive control: the operator path attaches the same address.
    const operated = await kit.pass({ holderEmail: user.primaryEmail });
    expect(operated.ownerUserId).toBe(user.id);
  });

  it('refuses a request that is not a join link or carries foreign fields', async () => {
    const l = await link();
    const before = await passCount();
    const bad: Partial<CreateParams>[] = [
      { actor: { type: 'system', id: 'join:other' } },
      { actor: { type: 'user', id: `join:${l.id}` } },
      { connectionId: 'c1' },
      { externalId: 'x' },
      { source: 'connection' },
    ];
    for (const over of bad)
      expect(await code(createPassRow(kit.ctx, params(l, over)))).toBe('FORBIDDEN');
    // A join ledger key outside a join execution.
    expect(
      await code(
        createPassRow(kit.ctx, {
          ...params(l),
          execution: { kind: 'system' },
          joinKeys: { ipKey: 'a', deviceKey: null, fieldsHash: null },
        }),
      ),
    ).toBe('FORBIDDEN');
    expect(await passCount()).toBe(before);
  });

  it('a link that is off, rotated or in another org makes nothing', async () => {
    const off = await link();
    await run(kit.env.DB, 'UPDATE join_links SET enabled = 0 WHERE id = ?', [off.id]);
    const rotated = await link({ mode: 'test' });
    await run(kit.env.DB, 'UPDATE join_links SET generation = generation + 1 WHERE id = ?', [
      rotated.id,
    ]);
    const before = await passCount();
    expect(await code(createPassRow(kit.ctx, params(off)))).toBe('JOIN_LINK_CLOSED');
    expect(await code(createPassRow(kit.ctx, params(rotated, { mode: 'test' })))).toBe(
      'JOIN_LINK_CLOSED',
    );
    expect(await passCount()).toBe(before);
    expect(await issues(off.id)).toEqual([]);
  });

  it('a test link never makes a live pass', async () => {
    const l = await link({ mode: 'test' });
    const before = await passCount();
    // The caller forges mode live: the grant's mode is the link's, so the release check refuses.
    expect(await code(createPassRow(kit.ctx, params(l, { mode: 'live' })))).toBe('JOIN_NOT_READY');
    expect(await passCount()).toBe(before);
    expect(await issues(l.id)).toEqual([]);
    const ok = await createPassRow(kit.ctx, params(l, { mode: 'test' }));
    expect(ok.mode).toBe('test');
  });

  it('a live link never makes a test pass', async () => {
    const l = await link();
    const before = await passCount();
    expect(await code(createPassRow(kit.ctx, params(l, { mode: 'test' })))).toBe('JOIN_NOT_READY');
    expect(await passCount()).toBe(before);
  });

  it('a test link whose template has only a live release does not fall back to live', async () => {
    const live = await setupKit({ approvedReleases: false });
    await approveAppleRelease(live);
    const l = await makeJoinLink(live.fx, {
      orgId: live.org.id,
      templateId: live.template.id,
      mode: 'test',
    });
    const before = (await first<{ n: number }>(live.env.DB, 'SELECT COUNT(*) AS n FROM passes'))?.n;
    const refused = await code(
      createPassRow(live.ctx, {
        orgId: live.org.id,
        templateId: live.template.id,
        templateVersion: live.template.version,
        input: { memberName: 'x' },
        source: 'manual',
        mode: 'test',
        execution: { kind: 'join', linkId: l.id, generation: 1, orgDailyCap: 50 },
        actor: { type: 'system', id: `join:${l.id}` },
      }),
    );
    expect(refused).toBe('TEMPLATE_RELEASE_REQUIRED');
    expect((await first<{ n: number }>(live.env.DB, 'SELECT COUNT(*) AS n FROM passes'))?.n).toBe(
      before,
    );
  });

  it('commits the per-link cap with the pass: one winner of ten at limit - 1', async () => {
    const l = await link({ dailyLimit: 2 });
    await createPassRow(kit.ctx, params(l));
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => createPassRow(kit.ctx, params(l))),
    );
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost.map((r) => (r as PromiseRejectedResult).reason.code)).toEqual(
      Array(9).fill('JOIN_LIMIT'),
    );
    expect(await issues(l.id)).toHaveLength(2);
  });

  it('caps the org across two links, and the cap rolls over 24 hours', async () => {
    const icon = new Uint8Array(
      await new Response(await kit.registry.openAsset(kit.template, 'icon.png')).arrayBuffer(),
    );
    const second = kit.registry.add({
      id: `tpl-${kit.fx.ids.token(4)}`,
      orgId: kit.template.orgId,
      version: kit.template.version,
      manifest: kit.template.manifest,
      passJson: kit.template.passJson,
      assets: { 'icon.png': icon },
    });
    await persistTemplate(kit.fx, second, { registry: kit.registry });
    await approveAppleRelease(kit, {
      templateId: second.id,
      version: second.version,
      mode: 'test',
    });
    const a = await link({ mode: 'test' });
    const b = await link({ mode: 'test', templateId: second.id });
    // Test-mode counts are per mode, so the org's earlier test cards count: read them first.
    const used =
      (
        await first<{ n: number }>(
          kit.env.DB,
          "SELECT COUNT(*) AS n FROM join_issues WHERE org_id = ? AND mode = 'test' AND created_at > ?",
          [kit.org.id, kit.clock.now() - DAY],
        )
      )?.n ?? 0;
    const cap = used + 1;
    await createPassRow(kit.ctx, params(a, { mode: 'test', orgDailyCap: cap }));
    const other = {
      ...params(b, { mode: 'test', orgDailyCap: cap }),
      templateId: second.id,
      templateVersion: second.version,
    };
    expect(await code(createPassRow(kit.ctx, other))).toBe('JOIN_LIMIT');
    kit.clock.advance(DAY + 1000);
    expect(await code(createPassRow(kit.ctx, other))).toBeNull();
  });

  it('two submits with one address make one pass; no address never dedupes', async () => {
    const l = await link();
    const email = `dup-${kit.fx.ids.token(4)}@example.com`;
    const results = await Promise.allSettled([
      createPassRow(kit.ctx, params(l, { holderEmail: email })),
      createPassRow(kit.ctx, params(l, { holderEmail: email })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason.code).toBe('JOIN_DUPLICATE');
    expect(await issues(l.id)).toHaveLength(1);
    // An operator card on the template counts as the active card.
    const operator = `op-${kit.fx.ids.token(4)}@example.com`;
    await kit.pass({ holderEmail: operator });
    expect(await code(createPassRow(kit.ctx, params(l, { holderEmail: operator })))).toBe(
      'JOIN_DUPLICATE',
    );
    // No address: no dedupe.
    await createPassRow(kit.ctx, params(l));
    await createPassRow(kit.ctx, params(l));
    // A removed card no longer blocks its address.
    const gone = await createPassRow(
      kit.ctx,
      params(l, { holderEmail: `r-${kit.fx.ids.token(4)}@example.com` }),
    );
    await run(kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [gone.id]);
    expect(
      await code(createPassRow(kit.ctx, params(l, { holderEmail: gone.holderEmail }))),
    ).toBeNull();
  });

  it('the grant is pinned to the new pass and only inserts', async () => {
    const l = await link();
    const victim = await kit.pass();
    const g = () =>
      joinCreateGrant(kit.ctx, {
        linkId: l.id,
        generation: l.generation,
        orgDailyCap: 100,
        orgId: kit.org.id,
        templateId: kit.template.id,
        passId: kit.fx.ids.id(),
        holderEmail: null,
        now: kit.clock.now(),
        checks: [],
      });
    expect(() =>
      g().update('passes', { where: { id: victim.id }, set: { holder_email: 'x@example.com' } }),
    ).toThrow(/only inserts/);
    expect(() => g().delete('join_issues', { where: { pass_id: victim.id } })).toThrow(
      /only inserts/,
    );
    expect(() =>
      g().insertSelect('pass_events', ['id', 'pass_id', 'kind', 'at'], ['e', victim.id, 'k', 1]),
    ).toThrow(/pass_id/);
    expect(() =>
      g().insertSelect(
        'join_issues',
        ['id', 'link_id', 'link_generation', 'created_at'],
        ['i', 'other', 1, 1],
        {
          from: { table: 'passes', where: { id: victim.id }, copy: { pass_id: 'id' } },
        },
      ),
    ).toThrow(/own link/);
  });

  it('queues the issuance mail as a system actor, sent only by a job', async () => {
    const l = await link();
    const pass = await createPassRow(
      kit.ctx,
      params(l, { holderEmail: `mail-${kit.fx.ids.token(4)}@example.com`, sendEmail: true }),
    );
    expect(await scheduleIssuanceDelivery(kit.ctx, pass.id, false)).toBe('deferred');
    expect(await scheduleIssuanceDelivery(jobCtxOf(kit), pass.id, false)).toBe('queued');
  });

  it('refuses a ledger digest that is not a 43-character base64url value', async () => {
    const l = await link();
    for (const bad of ['203.0.113.7', `${D1}=`, 'x'.repeat(44)])
      expect(
        await code(
          createPassRow(
            kit.ctx,
            params(l, { joinKeys: { ipKey: bad, deviceKey: null, fieldsHash: null } }),
          ),
        ),
      ).toBe('FORBIDDEN');
    expect(await issues(l.id)).toEqual([]);
  });

  it('refuses a chosen pass id', async () => {
    const l = await link();
    expect(await code(createPassRow(kit.ctx, params(l, { passId: kit.fx.ids.id() })))).toBe(
      'FORBIDDEN',
    );
  });

  it('takes an address only when the link asks for one', async () => {
    const l = await link({ askEmail: false });
    const before = await passCount();
    expect(
      await code(createPassRow(kit.ctx, params(l, { holderEmail: 'quiet@example.com' }))),
    ).toBe('JOIN_LIMIT');
    expect(await passCount()).toBe(before);
    expect(await code(createPassRow(kit.ctx, params(l)))).toBeNull();
  });

  it('never replays an idempotency key for a join link', async () => {
    const l = await link();
    expect(await code(createPassIdempotent(kit.ctx, params(l), 'key-1'))).toBe('FORBIDDEN');
  });

  it('a link of one org makes nothing for another org, and leaves no stored object', async () => {
    const other = await makeOrg(kit.fx, { name: 'Other Org' });
    await approveAppleRelease(kit, { orgId: other.id, mode: 'live' });
    const l = await link();
    const objects = async () => (await kit.env.BUCKET.list({ prefix: 'passes/' })).objects.length;
    const before = [await passCount(), await objects()];
    const refused = await code(createPassRow(kit.ctx, params(l, { orgId: other.id })));
    expect(refused).not.toBeNull();
    expect([await passCount(), await objects()]).toEqual(before);
    expect(await issues(l.id)).toEqual([]);
  });

  it('refuses a template whose barcode is not the scan code, before storing anything', async () => {
    const icon = new Uint8Array(
      await new Response(await kit.registry.openAsset(kit.template, 'icon.png')).arrayBuffer(),
    );
    const typed = joinTemplate(`tpl-typed-${kit.fx.ids.token(4)}`, '{{memberName}}').resolved;
    const added = kit.registry.add({
      id: typed.id,
      orgId: typed.orgId,
      version: typed.version,
      manifest: typed.manifest,
      passJson: typed.passJson,
      assets: { 'icon.png': icon },
    });
    await persistTemplate(kit.fx, added, { registry: kit.registry });
    const release = await approveAppleRelease(kit, {
      templateId: added.id,
      version: added.version,
    });
    const l = await link({ templateId: added.id });
    const objects = async () => (await kit.env.BUCKET.list({ prefix: 'passes/' })).objects.length;
    const before = [await passCount(), await objects()];
    const refused = await code(
      createPassRow(kit.ctx, {
        ...params(l),
        templateId: added.id,
        templateVersion: release.version,
      }),
    );
    expect(refused).toBe('JOIN_NOT_READY');
    expect([await passCount(), await objects()]).toEqual(before);
  });
});
