/// <reference types="vite/client" />

import { beforeAll, describe, expect, it } from 'vitest';
import { all, first } from '../../platform/db.ts';
import { type ForkKit, forkKit } from './fork-updates-test-fixtures.ts';

let k: ForkKit;
let n = 0;
const slug = () => `fork-demo-${++n}`;

beforeAll(async () => {
  k = await forkKit();
});

/** A blueprint at v1, a fork of it, and the fork's own edit: the shared start of most tests. */
async function started(v1 = {}) {
  const s = slug();
  await k.publish(s, v1);
  const id = await k.fork(s, `Copy of ${s}`);
  return { s, id };
}

const candidatesOf = (id: string, version: string) =>
  all<{ mode: string; author_id: string; version_author_id: string | null }>(
    k.kit.env.DB,
    'SELECT mode, author_id, version_author_id FROM template_candidates WHERE template_id = ? AND version = ? ORDER BY mode',
    [id, version],
  );

describe('a clean merge', () => {
  it('writes a version carrying both sides, its base and an offer, only after the sync', async () => {
    const { s, id } = await started();
    await k.edit(id, (d) => ({ ...d, passJson: { ...d.passJson, description: 'Mine' } }));
    const v2 = await k.publish(s, { tier: 'Level' });
    // Syncing writes no offer: the merge is the job's.
    expect(await k.updates(id)).toEqual([]);
    const sent = await k.tick();
    expect(sent).toHaveLength(1);
    const [row] = await k.updates(id);
    expect(row).toMatchObject({ status: 'clean', upstream_version: v2 });
    const merged = row?.merged_version ?? '';
    expect(merged).not.toBe(row?.ours_version);
    const stored = await first<{ pass_json: string }>(
      k.kit.env.DB,
      'SELECT pass_json FROM template_versions WHERE template_id = ? AND version = ?',
      [id, merged],
    );
    const pass = JSON.parse(stored?.pass_json ?? '{}');
    expect(pass.description).toBe('Mine');
    expect(pass.generic.secondaryFields[0].label).toBe('Level');
    expect((await k.bases(id)).find((b) => b.version === merged)).toMatchObject({
      upstream_version: v2,
      via: 'merge',
      parent_version: row?.ours_version,
      inferred: 0,
    });
    expect(JSON.parse(row?.summary ?? '{}')).toMatchObject({ changes: 1 });
    const audit = await first<{ actor_type: string; detail: string }>(
      k.kit.env.DB,
      "SELECT actor_type, detail FROM audit_log WHERE target_id = ? AND action = 'template.fork_update'",
      [id],
    );
    expect(audit?.actor_type).toBe('system');
    expect(JSON.parse(audit?.detail ?? '{}')).toMatchObject({
      status: 'clean',
      mergedVersion: merged,
    });
  });

  it('writes Apple candidates by the system in the modes the fork has a release in', async () => {
    const { s, id } = await started();
    const [first1] = await k.versions(id);
    await k.release(id, first1?.version ?? '');
    await k.publish(s, { tier: 'Level' });
    await k.tick();
    const [row] = await k.updates(id);
    expect(row?.status).toBe('clean');
    // Ours was approved by someone other than its author, and upstream came through repo review.
    expect(await candidatesOf(id, row?.merged_version ?? '')).toEqual([
      { mode: 'live', author_id: 'system:template-merge', version_author_id: null },
    ]);
    const version = await first<{ created_by: string | null }>(
      k.kit.env.DB,
      'SELECT created_by FROM template_versions WHERE template_id = ? AND version = ?',
      [id, row?.merged_version],
    );
    expect(version?.created_by).toBeNull();
  });

  it('writes no candidate in a mode with no release', async () => {
    const { s, id } = await started();
    await k.publish(s, { tier: 'Level' });
    await k.tick();
    const [row] = await k.updates(id);
    expect(row?.status).toBe('clean');
    expect(await candidatesOf(id, row?.merged_version ?? '')).toEqual([]);
  });
});

describe('the author of a merge', () => {
  it('is the author of unreviewed edits it builds on, who then cannot approve it', async () => {
    const { s, id } = await started();
    const [v1] = await k.versions(id);
    await k.release(id, v1?.version ?? '');
    // An unreviewed edit by the admin sits on top of the released version.
    await k.edit(id, (d) => ({ ...d, passJson: { ...d.passJson, description: 'Draft' } }));
    await k.publish(s, { tier: 'Level' });
    await k.tick();
    const [row] = await k.updates(id);
    expect(row?.status).toBe('clean');
    const admin = await first<{ created_by: string }>(
      k.kit.env.DB,
      'SELECT created_by FROM template_versions WHERE template_id = ? AND version = ?',
      [id, row?.ours_version],
    );
    expect(admin?.created_by).toBeTruthy();
    const merged = row?.merged_version ?? '';
    const [candidate] = await candidatesOf(id, merged);
    expect(candidate).toMatchObject({ version_author_id: admin?.created_by });
    const listed = (await (
      await k.kit.call(`/${id}/candidates?orgId=${k.kit.org.id}&mode=live&provider=apple`)
    ).json()) as { items: { id: string; version: string; candidateHash: string }[] };
    const offered = listed.items.find((c) => c.version === merged);
    const approve = (headers: Record<string, string>) =>
      k.kit.post(
        `/${id}/candidates/${offered?.id}/approve`,
        {
          orgId: k.kit.org.id,
          mode: 'live',
          provider: 'apple',
          candidateHash: offered?.candidateHash,
        },
        headers,
      );
    expect((await approve(k.kit.admin)).status).toBe(403);
    const reviewer = await k.kit.member(k.kit.org.id, ['template_reviewer']);
    expect((await approve(reviewer.headers)).status).toBe(201);
  });
});

describe('a conflicting merge', () => {
  it('records the conflicts and writes no version', async () => {
    const { s, id } = await started();
    await k.edit(id, (d) => {
      const generic = d.passJson.generic as { secondaryFields: { label: string }[] };
      return {
        ...d,
        passJson: {
          ...d.passJson,
          generic: {
            ...generic,
            secondaryFields: [{ ...generic.secondaryFields[0], label: 'Mine' }],
          },
        },
      };
    });
    const before = (await k.versions(id)).length;
    await k.publish(s, { tier: 'Theirs' });
    await k.tick();
    const [row] = await k.updates(id);
    expect(row).toMatchObject({ status: 'conflicted', merged_version: null });
    const conflicts = JSON.parse(row?.conflicts ?? '[]') as { part: string; kind: string }[];
    expect(conflicts).toEqual([expect.objectContaining({ part: 'fields', kind: 'both-changed' })]);
    expect(await k.versions(id)).toHaveLength(before);
    expect((await k.bases(id)).filter((b) => b.via === 'merge')).toEqual([]);
  });
});

describe('an invalid merge', () => {
  it('records the save pipeline’s errors when the merged template is refused', async () => {
    const { s, id } = await started();
    const before = (await k.versions(id)).length;
    // Baked templates may use schema keywords that uploaded ones may not.
    await k.publish(s, { keyword: { readOnly: true } });
    await k.tick();
    const [row] = await k.updates(id);
    expect(row).toMatchObject({ status: 'invalid', merged_version: null });
    expect(JSON.parse(row?.conflicts ?? '[]')).toEqual([
      expect.objectContaining({ kind: 'invalid', part: 'inputs' }),
    ]);
    expect(await k.versions(id)).toHaveLength(before);
  });
});

describe('a merge with no change', () => {
  it('records no change and that ours incorporates the upstream version', async () => {
    const { s, id } = await started();
    const before = (await k.versions(id)).length;
    // The blueprint flag is not content: a fork never carries it.
    const v2 = await k.publish(s, { blueprint: false });
    await k.tick();
    const [row] = await k.updates(id);
    expect(row).toMatchObject({ status: 'noop', merged_version: row?.ours_version });
    expect(await k.versions(id)).toHaveLength(before);
    expect(await k.bases(id)).toContainEqual(
      expect.objectContaining({ upstream_version: v2, via: 'noop', version: row?.ours_version }),
    );
    // Nothing more to offer for this upstream version.
    expect(await k.tick()).toEqual([]);
  });
});

describe('reruns', () => {
  it('are idempotent: no second offer, version, candidate or audit row', async () => {
    const { s, id } = await started();
    const [v1] = await k.versions(id);
    await k.release(id, v1?.version ?? '');
    await k.publish(s, { tier: 'Level' });
    expect(await k.tick()).toHaveLength(1);
    const snapshot = async () => ({
      updates: await k.updates(id),
      versions: await k.versions(id),
      bases: await k.bases(id),
      candidates: await all(
        k.kit.env.DB,
        'SELECT id FROM template_candidates WHERE template_id = ?',
        [id],
      ),
      audit: await all(
        k.kit.env.DB,
        "SELECT id FROM audit_log WHERE target_id = ? AND action = 'template.fork_update'",
        [id],
      ),
    });
    const once = await snapshot();
    expect(await k.tick()).toEqual([]);
    expect(await snapshot()).toEqual(once);
  });

  it('survive two jobs for the same offer', async () => {
    const { s, id } = await started();
    const [v1] = await k.versions(id);
    await k.release(id, v1?.version ?? '');
    await k.publish(s, { tier: 'Level' });
    const { handleForkUpdate } = await import('./fork-updates-job.ts');
    const { createJobContext } = await import('../../platform/service-context.ts');
    const { planForkUpdates } = await import('./fork-updates-plan.ts');
    const sent: unknown[] = [];
    const env = { ...k.kit.env, JOBS: { send: async (m: unknown) => void sent.push(m) } } as never;
    const ctx = createJobContext(env, 'twice', { clock: k.kit.clock });
    await planForkUpdates(ctx, k.source);
    const job = sent[0] as never;
    await Promise.all([handleForkUpdate(job, ctx), handleForkUpdate(job, ctx)]);
    const [row] = await k.updates(id);
    expect(row?.status).toBe('clean');
    expect(await candidatesOf(id, row?.merged_version ?? '')).toHaveLength(1);
  });
});
