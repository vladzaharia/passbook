/// <reference types="vite/client" />

import { beforeAll, describe, expect, it } from 'vitest';
import { withoutTrigger } from '../../../../test/helpers/triggers.ts';
import { CRON_HOOKS, MINUTE_CRON } from '../../jobs/cron.ts';
import { all, first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createJobContext } from '../../platform/service-context.ts';
import { RACE_TEMPLATE_VERSION_INSERT } from '../scan/race-tags.ts';
import { type ForkKit, forkKit, upload } from './fork-updates-test-fixtures.ts';
import { basicPackage, makePng, passJson, zipOf } from './package/fixtures.ts';
import { upstreamReadable } from './repo-fork-updates.ts';
import { importZip, sourceOf } from './testing.ts';
import { resolveVersionFiles } from './version-files.ts';

let k: ForkKit;
let n = 0;
const slug = () => `fork-fence-${++n}`;
const code = (row: { summary: string | null } | undefined) =>
  (JSON.parse(row?.summary ?? '{}') as { code?: string }).code;

beforeAll(async () => {
  k = await forkKit();
});

async function started(v1 = {}) {
  const s = slug();
  await k.publish(s, v1);
  return { s, id: await k.fork(s, `Copy of ${s}`) };
}

describe('the fence', () => {
  it('is lost to a concurrent edit of the fork: nothing is written, and the next tick merges the new tip', async () => {
    const { s, id } = await started();
    await k.publish(s, { tier: 'Level' });
    const { watchBatch } = await import('./testing.ts');
    const watched = watchBatch(k.kit.env, RACE_TEMPLATE_VERSION_INSERT, async () => {
      await k.edit(id, (d) => ({ ...d, passJson: { ...d.passJson, description: 'Human' } }));
    });
    await k.tick(watched.env);
    expect(watched.fired()).toBe(1);
    const [first1] = await k.updates(id);
    expect(first1).toMatchObject({ status: 'failed', merged_version: null });
    expect(code(first1)).toBe('TEMPLATE_FORK_STALE');
    expect((await k.bases(id)).filter((b) => b.via === 'merge')).toEqual([]);

    await k.tick();
    const rows = await k.updates(id);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ status: 'clean' });
    expect(rows[1]?.ours_version).not.toBe(first1?.ours_version);
  });

  it('is lost when the fork is paused or the upstream moves on, with no write', async () => {
    const { s, id } = await started();
    await k.publish(s, { tier: 'Level' });
    await run(k.kit.env.DB, "UPDATE template_forks SET tracking = 'paused' WHERE template_id = ?", [
      id,
    ]);
    expect(await k.tick()).toEqual([]);
    expect(await k.updates(id)).toEqual([]);
    await run(k.kit.env.DB, "UPDATE template_forks SET tracking = 'on' WHERE template_id = ?", [
      id,
    ]);
    // Two deploys before the job runs: only the active version is merged (a rebase on the latest).
    await k.publish(s, { tier: 'Level 2' });
    const sent = await k.tick();
    expect(sent).toHaveLength(1);
    const rows = await k.updates(id);
    expect(rows).toHaveLength(1);
    const pass = await first<{ pass_json: string }>(
      k.kit.env.DB,
      'SELECT pass_json FROM template_versions WHERE template_id = ? AND version = ?',
      [id, rows[0]?.merged_version],
    );
    expect(pass?.pass_json).toContain('Level 2');
  });
});

describe('planning', () => {
  it('waits for the sync to settle this build, and runs as a minute hook after it', async () => {
    const { s, id } = await started();
    await k.publish(s, { tier: 'Level' });
    expect(await k.plan(k.kit.env, sourceOf([], 'another-build'))).toEqual([]);
    expect(await k.updates(id)).toEqual([]);
    const names = (CRON_HOOKS[MINUTE_CRON] ?? []).map((h) => h.name);
    expect(names.indexOf('templates.fork_updates')).toBe(names.indexOf('templates.sync') + 1);
  });

  it('queues an offer that never finished once, after ten minutes, up to five times', async () => {
    const { s, id } = await started();
    await k.publish(s, { tier: 'Level' });
    expect(await k.plan()).toHaveLength(1);
    // The job was lost: the offer stays pending, and is not queued again at once.
    expect(await k.plan()).toEqual([]);
    k.kit.clock.advance(11 * 60_000);
    expect(await k.plan()).toHaveLength(1);
    expect((await k.updates(id))[0]).toMatchObject({ status: 'pending', attempts: 1 });
    await run(k.kit.env.DB, 'UPDATE template_fork_updates SET attempts = 5 WHERE template_id = ?', [
      id,
    ]);
    k.kit.clock.advance(11 * 60_000);
    expect(await k.plan()).toEqual([]);
  });

  it('offers the same tip again after another merge was left unaccepted', async () => {
    const { s, id } = await started();
    await k.publish(s, { tier: 'Level' });
    await k.tick();
    await k.publish(s, { tier: 'Level 3' });
    await k.tick();
    const [one, two] = await k.updates(id);
    expect([one?.status, two?.status]).toEqual(['clean', 'clean']);
    // The first merge was never accepted: the second is built on the same tip.
    expect(two?.ours_version).toBe(one?.ours_version);
    expect(two?.merged_version).not.toBe(one?.merged_version);
  });
});

describe('kept yours', () => {
  const branded = (json: string) =>
    run(k.kit.env.DB, 'UPDATE orgs SET branding = ? WHERE id = ?', [json, k.kit.org.id]);

  it('keeps the fork’s art and the values the org branding replaces', async () => {
    await branded('{"passColors":{"background":"#112233"}}');
    const { s, id } = await started({ logoWidth: 40 });
    await k.edit(id, (d) => ({
      ...d,
      passJson: { ...d.passJson, backgroundColor: 'rgb(1, 2, 3)' },
      assets: d.assets.map((a) => (a.name === 'logo.png' ? upload(50) : a)),
    }));
    await k.publish(s, { logoWidth: 60, background: 'rgb(9, 9, 9)', tier: 'Level' });
    await k.tick();
    const [row] = await k.updates(id);
    expect(row?.status).toBe('clean');
    const summary = JSON.parse(row?.summary ?? '{}') as {
      keptYours: { part: string; path: string[] }[];
    };
    expect(summary.keptYours.map((c) => `${c.part}:${c.path.join('/')}`).sort()).toEqual([
      'files.image:logo',
      'pass.meta:backgroundColor',
    ]);
    const stored = await first<{ pass_json: string }>(
      k.kit.env.DB,
      'SELECT pass_json FROM template_versions WHERE template_id = ? AND version = ?',
      [id, row?.merged_version],
    );
    expect(stored?.pass_json).toContain('rgb(1, 2, 3)');
  });

  it('still raises a clash the org does not decide', async () => {
    await branded('{}');
    const { s, id } = await started();
    await k.edit(id, (d) => ({
      ...d,
      passJson: { ...d.passJson, backgroundColor: 'rgb(1, 2, 3)' },
    }));
    await k.publish(s, { background: 'rgb(9, 9, 9)' });
    await k.tick();
    const [row] = await k.updates(id);
    expect(row?.status).toBe('conflicted');
    expect(JSON.parse(row?.conflicts ?? '[]')).toEqual([
      expect.objectContaining({ part: 'pass.meta', path: ['backgroundColor'] }),
    ]);
  });
});

describe('a fork with no recorded base', () => {
  const forget = (id: string) =>
    withoutTrigger(k.kit.env.DB, 'template_version_bases_no_delete', () =>
      run(k.kit.env.DB, 'DELETE FROM template_version_bases WHERE template_id = ?', [id]),
    );

  it('infers the upstream version an exact copy was made from, and merges from it', async () => {
    const { s, id } = await started();
    await forget(id);
    const v2 = await k.publish(s, { tier: 'Level' });
    await k.tick();
    const [row] = await k.updates(id);
    expect(row?.status).toBe('clean');
    const bases = await k.bases(id);
    expect(bases.find((b) => b.via === 'backfill')).toMatchObject({
      version: row?.ours_version,
      inferred: 1,
    });
    expect(bases.find((b) => b.via === 'merge')).toMatchObject({ upstream_version: v2 });
  });

  it('adopts the current version when nothing matches, and offers nothing', async () => {
    const s = slug();
    await k.publish(s);
    const got = (await (await k.kit.call(`/baked:${s}`)).json()) as { activeVersion: string };
    const draft = (await (
      await k.kit.call(`/baked:${s}/versions/${got.activeVersion}`)
    ).json()) as {
      passJson: Record<string, unknown>;
      manifest: Record<string, unknown>;
      assets: { name: string; sha1: string }[];
    };
    const res = await k.kit.post(`/baked:${s}/use`, {
      orgId: k.kit.org.id,
      name: `Edited ${s}`,
      version: {
        passJson: { ...draft.passJson, description: 'Before the copy' },
        manifest: draft.manifest,
        assets: draft.assets.map((a) => ({ name: a.name, sha1: a.sha1 })),
      },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const id = ((await res.json()) as { id: string }).id;
    await forget(id);
    await run(k.kit.env.DB, 'UPDATE template_forks SET created_at = 0 WHERE template_id = ?', [id]);
    const before = (await k.versions(id)).length;
    const v2 = await k.publish(s, { tier: 'Level' });
    await k.tick();
    const [row] = await k.updates(id);
    expect(row).toMatchObject({ status: 'noop', merged_version: row?.ours_version });
    expect(await k.versions(id)).toHaveLength(before);
    expect(await k.bases(id)).toEqual([
      expect.objectContaining({
        version: row?.ours_version,
        upstream_version: v2,
        via: 'backfill',
        inferred: 1,
      }),
    ]);
  });
});

/** A bucket that remembers every key it was asked for. */
function spied(env: AppEnv, reads: string[]): AppEnv {
  const BUCKET = new Proxy(env.BUCKET, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop !== 'get') return typeof value === 'function' ? value.bind(target) : value;
      return (key: string, ...rest: unknown[]) => {
        reads.push(key);
        return (target.get as (...a: unknown[]) => unknown)(key, ...rest);
      };
    },
  });
  return { ...env, BUCKET };
}

describe('files of an upstream', () => {
  it('come from a baked upstream, never as the fork’s own', async () => {
    const { s, id } = await started({ logoWidth: 40 });
    await k.publish(s, { logoWidth: 60 });
    const upstream = `baked:${s}`;
    const row = await first<{ assets: string }>(
      k.kit.env.DB,
      'SELECT assets FROM template_versions WHERE template_id = ? ORDER BY created_at DESC LIMIT 1',
      [upstream],
    );
    const logo = (JSON.parse(row?.assets ?? '[]') as { name: string; sha1: string }[]).find(
      (a) => a.name === 'logo.png',
    );
    const ctx = createJobContext(k.kit.env, 'files', { clock: k.kit.clock });
    const input = [{ name: 'logo.png', sha1: logo?.sha1 ?? '' }];
    const got = await resolveVersionFiles(ctx, id, input, { upstreamId: upstream });
    expect(got.files.get('logo.png')?.length).toBeGreaterThan(0);
    expect(got.carried.size).toBe(0);
    // Without the lineage the hash is no file of the fork.
    await expect(resolveVersionFiles(ctx, id, input)).rejects.toMatchObject({
      code: 'ASSETS_INVALID',
    });
  });

  it('are not read from another org’s uploaded template', async () => {
    const zip = (width: number) =>
      zipOf(
        basicPackage(
          {
            'wallet.template.json': JSON.stringify({
              schema: 1,
              name: 'Their design',
              inputs: { type: 'object', properties: { name: { type: 'string' } } },
              sample: { name: 'Alex' },
              bindings: [{ to: { field: 'name' }, value: '{{name}}' }],
              display: { title: '{{name}}' },
            }),
            'logo.png': makePng(width, 40),
          },
          passJson(),
        ),
      );
    const first1 = await importZip(k.kit.env, k.kit.clock, {
      orgId: k.kit.other.id,
      zip: zip(40),
      name: 'Their design',
    });
    const theirs = first1.result?.templateId ?? '';
    const copy = await k.kit.post(`/${theirs}/clone`, { orgId: k.kit.org.id, name: 'Our copy' });
    expect(copy.status, await copy.clone().text()).toBe(201);
    const id = ((await copy.json()) as { id: string }).id;
    const second = await importZip(k.kit.env, k.kit.clock, {
      orgId: k.kit.other.id,
      zip: zip(60),
      name: 'Their design',
    });
    const newest = await first<{ assets: string }>(
      k.kit.env.DB,
      'SELECT assets FROM template_versions WHERE template_id = ? AND version = ?',
      [theirs, second.result?.version],
    );
    const logo = (JSON.parse(newest?.assets ?? '[]') as { name: string; sha1: string }[]).find(
      (a) => a.name === 'logo.png',
    );
    const reads: string[] = [];
    const env = spied(k.kit.env, reads);
    const ctx = createJobContext(env, 'files', { clock: k.kit.clock });
    await expect(
      resolveVersionFiles(ctx, id, [{ name: 'logo.png', sha1: logo?.sha1 ?? '' }], {
        upstreamId: theirs,
      }),
    ).rejects.toMatchObject({ code: 'ASSETS_INVALID' });
    // Lineage only: the planner never offers it, and a forced offer is failed without a read.
    const sent = await k.tick(env);
    expect(sent.filter((m) => (m as { templateId: string }).templateId === id)).toEqual([]);
    const [fork] = await all<{ version: string }>(
      k.kit.env.DB,
      'SELECT version FROM template_versions WHERE template_id = ? LIMIT 1',
      [id],
    );
    await run(
      k.kit.env.DB,
      `INSERT INTO template_fork_updates (id, template_id, org_id, upstream_id, upstream_version, ours_version, status, engine_revision, created_at, updated_at)
       VALUES ('forced', ?, ?, ?, ?, ?, 'pending', 1, 1, 1)`,
      [id, k.kit.org.id, theirs, second.result?.version ?? '', fork?.version ?? ''],
    );
    const { handleForkUpdate } = await import('./fork-updates-job.ts');
    await handleForkUpdate(
      { kind: 'template.fork_update', updateId: 'forced', templateId: id, orgId: k.kit.org.id },
      ctx,
    );
    expect((await k.updates(id))[0]).toMatchObject({ status: 'failed', merged_version: null });
    expect(reads.filter((key) => key.includes(`/${k.kit.other.id}/${theirs}/`))).toEqual([]);
  });
});

describe('a refusal that a re-plan would not change', () => {
  it('leaves the offer pending, and the retry lane finishes it', async () => {
    const { s, id } = await started();
    await k.publish(s, { tier: 'Level' });
    const { watchBatch } = await import('./testing.ts');
    const watched = watchBatch(k.kit.env, RACE_TEMPLATE_VERSION_INSERT, () =>
      run(k.kit.env.DB, "UPDATE template_forks SET tracking = 'paused' WHERE template_id = ?", [
        id,
      ]),
    );
    await k.tick(watched.env);
    expect(watched.fired()).toBe(1);
    expect((await k.updates(id))[0]).toMatchObject({ status: 'pending' });
    await run(k.kit.env.DB, "UPDATE template_forks SET tracking = 'on' WHERE template_id = ?", [
      id,
    ]);
    k.kit.clock.advance(11 * 60_000);
    await k.tick();
    expect((await k.updates(id))[0]).toMatchObject({ status: 'clean', attempts: 1 });
  });
});

describe('a suspended org', () => {
  it('keeps its offers out of the retry lane until it is active again', async () => {
    const { s, id } = await started();
    await k.publish(s, { tier: 'Level' });
    expect(await k.plan()).toHaveLength(1);
    await run(k.kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [k.kit.org.id]);
    k.kit.clock.advance(11 * 60_000);
    expect((await k.tick()).filter((m) => (m as { templateId: string }).templateId === id)).toEqual(
      [],
    );
    expect((await k.updates(id))[0]).toMatchObject({ status: 'pending', attempts: 0 });
    await run(k.kit.env.DB, "UPDATE orgs SET status = 'active' WHERE id = ?", [k.kit.org.id]);
    k.kit.clock.advance(11 * 60_000);
    await k.tick();
    expect((await k.updates(id))[0]).toMatchObject({ status: 'clean' });
  });
});

describe('logoText', () => {
  const branded = (json: string) =>
    run(k.kit.env.DB, 'UPDATE orgs SET branding = ? WHERE id = ?', [json, k.kit.org.id]);
  const clash = async () => {
    const { s, id } = await started({ logoText: 'Base' });
    await k.edit(id, (d) => ({ ...d, passJson: { ...d.passJson, logoText: 'Mine' } }));
    await k.publish(s, { logoText: 'Theirs' });
    await k.tick();
    return (await k.updates(id))[0];
  };

  it('is kept as the fork’s when the org branding drops it', async () => {
    await branded('{"logoHasName":true}');
    const row = await clash();
    expect(row?.status).toBe('noop');
    expect(JSON.parse(row?.summary ?? '{}').keptYours).toEqual([
      expect.objectContaining({ path: ['logoText'] }),
    ]);
  });

  it('is a clash like any other when the org branding does not', async () => {
    await branded('{}');
    expect((await clash())?.status).toBe('conflicted');
  });
});

describe('who may supply files', () => {
  it('is a platform-wide template for any org, and an org’s built-in only for that org', async () => {
    const { id } = await started();
    const db = k.kit.env.DB;
    expect(await upstreamReadable(db, 'baked:starter-store-card', id)).toBe(true);
    expect(await upstreamReadable(db, 'baked:henrys-blue', id)).toBe(false);
    const res = await k.kit.post('/baked:henrys-blue/clone', {
      orgId: k.kit.henrys.id,
      name: 'Henry copy',
    });
    const henrys = ((await res.json()) as { id: string }).id;
    expect(await upstreamReadable(db, 'baked:henrys-blue', henrys)).toBe(true);
  });
});
