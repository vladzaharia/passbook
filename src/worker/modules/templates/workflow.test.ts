import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { fixtures, makeEnv, makeOrg } from '../../../../test/helpers/index.ts';
import { first } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { TemplateImport, type TemplateImportParams } from '../../workflows/template-import.ts';
import { basicPackage, makePng, zipOf } from './package/fixtures.ts';
import { getImport, insertImport } from './repo.ts';

let env: AppEnv;
let orgId: string;

beforeAll(async () => {
  env = await makeEnv();
  orgId = (await makeOrg(fixtures(env))).id;
});

/** The runtime constructor needs a native ExecutionContext; the workflow only reads `env`. */
function workflow(): TemplateImport {
  const instance = Object.create(TemplateImport.prototype) as TemplateImport;
  Object.defineProperty(instance, 'env', { value: env });
  return instance;
}

/** Runs steps inline and records their names. */
function inlineStep(names: string[]): WorkflowStep {
  return {
    do: async (name: string, a: unknown, b?: unknown) => {
      names.push(name);
      return ((typeof a === 'function' ? a : b) as () => unknown)();
    },
  } as unknown as WorkflowStep;
}

async function start(zip: Uint8Array): Promise<TemplateImportParams> {
  const uploadId = crypto.randomUUID();
  const p = { uploadId, orgId, objectKey: `uploads/${uploadId}.zip`, createdBy: null };
  await env.BUCKET.put(p.objectKey, zip);
  await insertImport(env.DB, { ...p, name: 'Workflow Card', now: Date.now() });
  return p;
}

const event = (payload: TemplateImportParams) =>
  ({
    payload,
    timestamp: new Date(),
    instanceId: payload.uploadId,
  }) as WorkflowEvent<TemplateImportParams>;

describe('TemplateImport workflow', () => {
  it('runs every step and persists the version using the real Images binding or its fallback', async () => {
    const p = await start(zipOf(basicPackage()));
    const names: string[] = [];
    await workflow().run(event(p), inlineStep(names));
    expect(names).toEqual(['start', 'extract', 'analyze', 'dry-run', 'persist', 'cleanup']);
    const row = await getImport(env.DB, p.uploadId);
    expect(row).toMatchObject({ step: 'done', workflowStatus: 'complete' });
    expect(await env.BUCKET.head(p.objectKey)).toBeNull();
  });

  it('stops at the first rejected stage and still cleans up', async () => {
    const p = await start(zipOf(basicPackage({ 'icon.png': makePng(5, 5) })));
    const names: string[] = [];
    await workflow().run(event(p), inlineStep(names));
    expect(names).toEqual(['start', 'extract', 'analyze', 'cleanup']);
    const row = await getImport(env.DB, p.uploadId);
    expect(row).toMatchObject({ error: 'IMPORT_INVALID', workflowStatus: 'errored' });
    expect(await env.BUCKET.head(p.objectKey)).toBeNull();
  });

  it('marks the run errored when a step throws, then rethrows', async () => {
    const p = await start(zipOf(basicPackage()));
    const step = {
      do: async (name: string, a: unknown, b?: unknown) => {
        if (name === 'analyze') throw new Error('boom');
        return ((typeof a === 'function' ? a : b) as () => unknown)();
      },
    } as unknown as WorkflowStep;
    await expect(workflow().run(event(p), step)).rejects.toThrow('boom');
    expect(await env.BUCKET.head(p.objectKey)).toBeNull();
    expect((await env.BUCKET.list({ prefix: `uploads/${p.uploadId}/` })).objects).toHaveLength(0);
    const run = await first<{ status: string; error_code: string }>(
      env.DB,
      'SELECT status, error_code FROM workflow_runs WHERE instance_id = ?',
      [p.uploadId],
    );
    expect(run).toEqual({ status: 'errored', error_code: 'IMPORT_FAILED' });
    expect((await getImport(env.DB, p.uploadId))?.report?.issues[0]?.code).toBe('IMPORT_FAILED');
  });
});
