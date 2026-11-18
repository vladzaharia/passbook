/// <reference types="vite/client" />

import { expect } from 'vitest';
import { JobSchema } from '../../jobs/types.ts';
import { all, first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createJobContext, createServiceContext } from '../../platform/service-context.ts';
import { type BlueprintKit, blueprintKit } from './blueprint-test-fixtures.ts';
import { handleForkUpdate } from './fork-updates-job.ts';
import { planForkUpdates } from './fork-updates-plan.ts';
import { basicPackage, makePng, passJson } from './package/fixtures.ts';
import { resetBakedSync, type SyncSource, syncBakedTemplates } from './sync.ts';
import { bakedFrom, sourceOf } from './testing.ts';

/** What an upstream build changes between versions. */
export interface Variant {
  tier?: string;
  description?: string;
  background?: string;
  logoWidth?: number;
  blueprint?: boolean;
  logoText?: string;
  /** Extra keyword on the tier input: baked templates may use any, uploaded ones refuse some. */
  keyword?: Record<string, unknown>;
}

export interface UpdateRow {
  id: string;
  template_id: string;
  ours_version: string;
  upstream_version: string;
  base_version: string | null;
  merged_version: string | null;
  status: string;
  conflicts: string | null;
  summary: string | null;
  attempts: number;
}

export interface BaseRow {
  version: string;
  upstream_version: string;
  via: string;
  parent_version: string | null;
  inferred: number;
}

export interface ForkKit {
  kit: BlueprintKit;
  source: SyncSource;
  publish(slug: string, v?: Variant): Promise<string>;
  fork(slug: string, name: string): Promise<string>;
  edit(id: string, change: (d: Draft) => Draft): Promise<string>;
  /** Plans without running the jobs; returns the queued messages. */
  plan(env?: AppEnv, source?: SyncSource): Promise<unknown[]>;
  tick(env?: AppEnv, source?: SyncSource): Promise<unknown[]>;
  updates(id: string): Promise<UpdateRow[]>;
  bases(id: string): Promise<BaseRow[]>;
  versions(id: string): Promise<{ version: string; created_by: string | null }[]>;
  release(id: string, version: string, mode?: 'live' | 'test'): Promise<void>;
}

export interface Draft {
  passJson: Record<string, unknown>;
  manifest: Record<string, unknown>;
  assets: ({ name: string; sha1: string } | { name: string; upload: string })[];
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

function files(slug: string, v: Variant) {
  const manifest = {
    schema: 1,
    name: slug,
    blueprint: v.blueprint ?? true,
    inputs: {
      type: 'object',
      properties: { name: { type: 'string' }, tier: { type: 'string', ...v.keyword } },
    },
    sample: { name: 'Alex', tier: 'Gold' },
    bindings: [{ to: { field: 'name' }, value: '{{name}}' }],
    display: { title: '{{name}}', icon: 'stamp' },
  };
  const pass = passJson({
    description: v.description ?? 'Fork demo',
    backgroundColor: v.background ?? 'rgb(10, 20, 30)',
    ...(v.logoText ? { logoText: v.logoText } : {}),
    generic: {
      primaryFields: [{ key: 'name', label: 'Name', value: 'Alex' }],
      secondaryFields: [{ key: 'tier', label: v.tier ?? 'Tier', value: 'Gold' }],
    },
  });
  return basicPackage(
    {
      'wallet.template.json': JSON.stringify(manifest),
      ...(v.logoWidth ? { 'logo.png': makePng(v.logoWidth, 40) } : {}),
    },
    pass,
  );
}

export async function forkKit(): Promise<ForkKit> {
  const kit = await blueprintKit();
  // The kit synced the generated build with no worker id: forget it so these builds are not "older".
  await run(
    kit.env.DB,
    "DELETE FROM settings WHERE scope = 'system' AND key IN ('templates.baked_adoption', 'templates.baked_hash')",
  );
  let build = 0;
  const jobContext = (env: AppEnv) =>
    createJobContext(env, 'fork-updates-test', { clock: kit.clock });
  const self: ForkKit = {
    kit,
    source: sourceOf([]),
    async publish(slug, v = {}) {
      const fixture = await bakedFrom(slug, files(slug, v));
      for (const [path, bytes] of fixture.files)
        (kit.env.ASSETS as unknown as { files: Map<string, Uint8Array> }).files.set(path, bytes);
      build += 1;
      resetBakedSync();
      const worker: AppEnv = {
        ...kit.env,
        CF_VERSION: {
          id: `fork-${build}`,
          tag: '',
          timestamp: new Date(Date.UTC(2041, 0, 1) + build * 1000).toISOString(),
        },
      };
      kit.clock.set(kit.clock.now() + 1000);
      self.source = sourceOf([fixture], `fork-build-${build}`);
      await syncBakedTemplates(createServiceContext(worker, { clock: kit.clock }), self.source);
      return fixture.template.version;
    },
    async fork(slug, name) {
      const res = await kit.post(`/baked:${slug}/use`, { orgId: kit.org.id, name });
      expect(res.status, await res.clone().text()).toBe(201);
      return ((await res.json()) as { id: string }).id;
    },
    async edit(id, change) {
      const tip = await first<{ version: string }>(
        kit.env.DB,
        'SELECT version FROM template_versions WHERE template_id = ? ORDER BY created_at DESC, version DESC LIMIT 1',
        [id],
      );
      const got = (await (await kit.call(`/${id}/versions/${tip?.version}`)).json()) as {
        passJson: Record<string, unknown>;
        manifest: Record<string, unknown>;
        assets: { name: string; sha1: string }[];
      };
      const draft = change({
        passJson: got.passJson,
        manifest: got.manifest,
        assets: got.assets.map((a) => ({ name: a.name, sha1: a.sha1 })),
      });
      kit.clock.advance(1000);
      const res = await kit.post(`/${id}/versions`, { ...draft, parentVersion: tip?.version });
      expect(res.status, await res.clone().text()).toBe(200);
      return ((await res.json()) as { version: string }).version;
    },
    async plan(env = kit.env, source = self.source) {
      const sent: unknown[] = [];
      const queued = {
        ...env,
        JOBS: {
          sendBatch: async (ms: { body: unknown }[]) => void sent.push(...ms.map((m) => m.body)),
        },
      };
      kit.clock.advance(1000);
      await planForkUpdates(jobContext(queued as unknown as AppEnv), source);
      return sent;
    },
    async tick(env = kit.env, source = self.source) {
      const sent: unknown[] = [];
      const queued = {
        ...env,
        JOBS: {
          sendBatch: async (ms: { body: unknown }[]) => void sent.push(...ms.map((m) => m.body)),
        },
      };
      const ctx = jobContext(queued as unknown as AppEnv);
      kit.clock.advance(1000);
      await planForkUpdates(ctx, source);
      for (const message of sent) await handleForkUpdate(JobSchema.parse(message) as never, ctx);
      return sent;
    },
    updates: (id) =>
      all<UpdateRow>(
        kit.env.DB,
        'SELECT * FROM template_fork_updates WHERE template_id = ? ORDER BY created_at, id',
        [id],
      ),
    bases: (id) =>
      all<BaseRow>(
        kit.env.DB,
        'SELECT * FROM template_version_bases WHERE template_id = ? ORDER BY created_at, version, upstream_version',
        [id],
      ),
    versions: (id) =>
      all(
        kit.env.DB,
        'SELECT version, created_by FROM template_versions WHERE template_id = ? ORDER BY created_at, version',
        [id],
      ),
    async release(id, version, mode = 'live') {
      const reviewer = await kit.member(kit.org.id, ['template_reviewer']);
      const scope = { orgId: kit.org.id, mode, provider: 'apple' };
      const hdr: Record<string, string> = mode === 'test' ? { 'x-passbook-mode': 'test' } : {};
      const made = await kit.post(
        `/${id}/candidates`,
        { ...scope, version },
        { ...kit.admin, ...hdr },
      );
      expect(made.status, await made.clone().text()).toBe(201);
      const c = (await made.json()) as { id: string; candidateHash: string };
      const approved = await kit.post(
        `/${id}/candidates/${c.id}/approve`,
        { ...scope, candidateHash: c.candidateHash },
        { ...reviewer.headers, ...hdr },
      );
      expect(approved.status, await approved.clone().text()).toBe(201);
      const a = (await approved.json()) as { id: string };
      const released = await kit.post(
        `/${id}/releases`,
        {
          ...scope,
          candidateId: c.id,
          approvalId: a.id,
          candidateHash: c.candidateHash,
          expectedGeneration: 0,
        },
        { ...kit.admin, ...hdr },
      );
      expect(released.status, await released.clone().text()).toBe(201);
    },
  };
  return self;
}

export const upload = (width: number) => ({ name: 'logo.png', upload: b64(makePng(width, 40)) });
