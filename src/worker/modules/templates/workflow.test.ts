import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { guardWrites } from '../../../../test/helpers/guarded-step.ts';
import {
  fixtures,
  makeEnv,
  makeOrg,
  makeSession,
  makeUser,
} from '../../../../test/helpers/index.ts';
import { ManualClock } from '../../platform/clock.ts';
import { first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { TemplateImport, type TemplateImportParams } from '../../workflows/template-import.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { authorizeTemplateWrite, type TemplateAuthority } from './access.ts';
import { basicPackage, makePng, zipOf } from './package/fixtures.ts';
import { getImport, getVersion, insertImport } from './repo.ts';
import { type TemplateAuthorFixture, templateAuthor } from './testing.ts';

let env: AppEnv;
let clock: ManualClock;
let orgId: string;
let author: TemplateAuthorFixture;

beforeAll(async () => {
  env = await makeEnv();
  clock = new ManualClock(Date.now());
  orgId = (await makeOrg(fixtures(env, clock))).id;
  author = await templateAuthor(env, clock, orgId);
});

/** The runtime constructor needs a native ExecutionContext; the workflow only reads `env`. */
function workflow(over: AppEnv = env): TemplateImport {
  const instance = Object.create(TemplateImport.prototype) as TemplateImport;
  Object.defineProperty(instance, 'env', { value: over });
  return instance;
}

/** Sign-in records the administrator role; a deferred platform import checks it, not the session. */
const setAdmin = (userId: string) =>
  run(env.DB, 'UPDATE users SET last_roles = ? WHERE id = ?', ['["admin","user"]', userId]);

/** Runs steps inline and records their names. */
function inlineStep(names: string[]): WorkflowStep {
  return {
    do: async (name: string, a: unknown, b?: unknown) => {
      names.push(name);
      return ((typeof a === 'function' ? a : b) as () => unknown)();
    },
  } as unknown as WorkflowStep;
}

/** Intervene immediately before or after the persist step's first D1 batch. */
function beforePersistBatch(
  intervene: () => Promise<unknown>,
  phase: 'before' | 'after' = 'before',
) {
  let armed = false;
  let hits = 0;
  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          const selected = armed;
          if (selected) {
            armed = false;
            hits++;
          }
          if (selected && phase === 'before') await intervene();
          const result = await target.batch(statements);
          if (selected && phase === 'after') await intervene();
          return result;
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const step = {
    do: async (stage: string, a: unknown, b?: unknown) => {
      if (stage === 'persist') armed = true;
      return ((typeof a === 'function' ? a : b) as () => unknown)();
    },
  } as unknown as WorkflowStep;
  return { env: { ...env, DB: db }, step, hits: () => hits };
}

async function start(
  zip: Uint8Array,
  options: {
    name?: string;
    orgId?: string | null;
    authority?: TemplateAuthority;
    createdBy?: string;
  } = {},
): Promise<TemplateImportParams> {
  const uploadId = crypto.randomUUID();
  const p: TemplateImportParams = {
    uploadId,
    orgId: options.orgId === undefined ? orgId : options.orgId,
    objectKey: `uploads/${uploadId}.zip`,
    createdBy: options.createdBy ?? author.userId,
    authority: options.authority ?? author.authority,
  };
  await env.BUCKET.put(p.objectKey, zip);
  await insertImport(env.DB, { ...p, name: options.name ?? 'Workflow Card', now: clock.now() });
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
    expect(
      await first<{ active_version: string | null }>(
        env.DB,
        'SELECT active_version FROM templates WHERE id = ?',
        [row?.templateId],
      ),
    ).toEqual({ active_version: null });
    expect(await getVersion(env.DB, row?.templateId ?? '', row?.version ?? '')).not.toBeNull();
    expect(await env.BUCKET.head(p.objectKey)).toBeNull();
  });

  it('rejects legacy workflow payloads without authority', async () => {
    const p = await start(zipOf(basicPackage()), { name: 'Legacy Workflow' });
    const legacy: Partial<TemplateImportParams> = { ...p };
    delete legacy.authority;
    await expect(
      workflow().run(event(legacy as TemplateImportParams), inlineStep([])),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await getImport(env.DB, p.uploadId)).toMatchObject({
      step: 'failed',
      error: 'FORBIDDEN',
      workflowStatus: 'errored',
      templateId: null,
      version: null,
    });
    expect(
      await first(env.DB, "SELECT id FROM templates WHERE slug = 'legacy-workflow'"),
    ).toBeNull();
    expect(await env.BUCKET.head(p.objectKey)).toBeNull();
  });

  it('rejects an authority from another organization', async () => {
    const otherOrg = await makeOrg(fixtures(env, clock));
    const otherAuthor = await templateAuthor(env, clock, otherOrg.id);
    const p = await start(zipOf(basicPackage()), {
      name: 'Wrong Org Workflow',
      authority: otherAuthor.authority,
    });
    await expect(workflow().run(event(p), inlineStep([]))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await getImport(env.DB, p.uploadId)).toMatchObject({
      step: 'queued',
      workflowStatus: 'queued',
      templateId: null,
    });
    expect(await env.BUCKET.head(p.objectKey)).not.toBeNull();
    expect(
      await first(env.DB, "SELECT id FROM templates WHERE slug = 'wrong-org-workflow'"),
    ).toBeNull();
  });

  it('rejects substitution of both the organization and its authority', async () => {
    const otherOrg = await makeOrg(fixtures(env, clock));
    const otherAuthor = await templateAuthor(env, clock, otherOrg.id);
    const p = await start(zipOf(basicPackage()), { name: 'Forged Upload Org' });
    const forged = {
      ...p,
      orgId: otherOrg.id,
      authority: otherAuthor.authority,
      createdBy: otherAuthor.userId,
    };
    await expect(workflow().run(event(forged), inlineStep([]))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await getImport(env.DB, p.uploadId)).toMatchObject({
      orgId,
      step: 'queued',
      workflowStatus: 'queued',
      templateId: null,
    });
    expect(await env.BUCKET.head(p.objectKey)).not.toBeNull();
    expect(
      await first(env.DB, "SELECT id FROM templates WHERE slug = 'forged-upload-org'"),
    ).toBeNull();
  });

  it('does not change either upload when a payload substitutes another object key', async () => {
    const p = await start(zipOf(basicPackage()), { name: 'Original Upload' });
    const other = await start(zipOf(basicPackage()), { name: 'Other Upload' });
    const forged = { ...p, objectKey: other.objectKey };
    await expect(workflow().run(event(forged), inlineStep([]))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await getImport(env.DB, p.uploadId)).toMatchObject({
      step: 'queued',
      workflowStatus: 'queued',
      objectKey: p.objectKey,
    });
    expect(await getImport(env.DB, other.uploadId)).toMatchObject({
      step: 'queued',
      workflowStatus: 'queued',
      objectKey: other.objectKey,
    });
    expect(await env.BUCKET.head(p.objectKey)).not.toBeNull();
    expect(await env.BUCKET.head(other.objectKey)).not.toBeNull();
  });

  it.each([false, true])(
    'rejects another principal even when the payload creator is changed: %s',
    async (changeCreator) => {
      const substitute = await templateAuthor(env, clock, orgId);
      const p = await start(zipOf(basicPackage()), { name: `Substitute Creator ${changeCreator}` });
      const forged = {
        ...p,
        authority: substitute.authority,
        createdBy: changeCreator ? substitute.userId : p.createdBy,
      };
      await expect(workflow().run(event(forged), inlineStep([]))).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(await getImport(env.DB, p.uploadId)).toMatchObject({
        step: 'queued',
        workflowStatus: 'queued',
        templateId: null,
      });
      expect(await env.BUCKET.head(p.objectKey)).not.toBeNull();
      expect(
        await first(env.DB, 'SELECT id FROM templates WHERE slug = ?', [
          `substitute-creator-${changeCreator}`,
        ]),
      ).toBeNull();
    },
  );

  it('rejects a workflow payload with no original creator', async () => {
    const p = await start(zipOf(basicPackage()), { name: 'Missing Creator' });
    await expect(
      workflow().run(event({ ...p, createdBy: null }), inlineStep([])),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await getImport(env.DB, p.uploadId)).toMatchObject({
      step: 'queued',
      workflowStatus: 'queued',
      templateId: null,
    });
    expect(await env.BUCKET.head(p.objectKey)).not.toBeNull();
    expect(
      await first(env.DB, "SELECT id FROM templates WHERE slug = 'missing-creator'"),
    ).toBeNull();
  });

  it('does not let a publisher-only grant author a workflow import', async () => {
    const f = fixtures(env, clock);
    const user = await makeUser(f);
    const invitationId = f.ids.id();
    const roles = JSON.stringify(['template_publisher']);
    const now = clock.now();
    await run(
      env.DB,
      `INSERT INTO org_invitations
        (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [invitationId, orgId, user.primaryEmail, roles, f.ids.token(), now, now + 3600_000, now],
    );
    await run(
      env.DB,
      `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [f.ids.id(), orgId, user.id, invitationId, roles, now],
    );
    const session = await makeSession(f, { userId: user.id });
    const auth = await createSessionStore(env, clock).resolve(session.cookieValue);
    if (!auth) throw new Error('The persisted publisher session did not resolve');
    const authority = await authorizeTemplateWrite(
      createServiceContext(env, { clock }),
      auth,
      orgId,
      'templates:publish',
    );
    const p = await start(zipOf(basicPackage()), {
      name: 'Publisher Import',
      authority,
      createdBy: user.id,
    });
    await expect(workflow().run(event(p), inlineStep([]))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await getImport(env.DB, p.uploadId)).toMatchObject({
      step: 'queued',
      workflowStatus: 'queued',
      templateId: null,
    });
    expect(await env.BUCKET.head(p.objectKey)).not.toBeNull();
    expect(
      await first(env.DB, "SELECT id FROM templates WHERE slug = 'publisher-import'"),
    ).toBeNull();
  });

  it('accepts a real platform session only for the platform organization', async () => {
    const f = fixtures(env, clock);
    const user = await makeUser(f);
    await setAdmin(user.id);
    const session = await makeSession(f, { userId: user.id, roles: ['admin', 'user'] });
    const auth = await createSessionStore(env, clock).resolve(session.cookieValue);
    if (!auth) throw new Error('The persisted platform session did not resolve');
    const authority = await authorizeTemplateWrite(
      createServiceContext(env, { clock }),
      auth,
      null,
      'templates:author',
    );
    const p = await start(zipOf(basicPackage()), {
      name: 'Platform Draft',
      orgId: null,
      authority,
      createdBy: user.id,
    });
    await workflow().run(event(p), inlineStep([]));
    const imported = await getImport(env.DB, p.uploadId);
    expect(imported).toMatchObject({ step: 'done', workflowStatus: 'complete' });
    expect(
      await first<{ org_id: string | null; active_version: string | null }>(
        env.DB,
        'SELECT org_id, active_version FROM templates WHERE id = ?',
        [imported?.templateId],
      ),
    ).toEqual({ org_id: null, active_version: null });

    const wrongOrg = await start(zipOf(basicPackage()), {
      name: 'Platform In Tenant',
      authority,
      createdBy: user.id,
    });
    await expect(workflow().run(event(wrongOrg), inlineStep([]))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await getImport(env.DB, wrongOrg.uploadId)).toMatchObject({
      step: 'queued',
      workflowStatus: 'queued',
    });
    expect(await env.BUCKET.head(wrongOrg.objectKey)).not.toBeNull();
    const wrongPlatform = await start(zipOf(basicPackage()), {
      name: 'Tenant In Platform',
      orgId: null,
    });
    await expect(workflow().run(event(wrongPlatform), inlineStep([]))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await getImport(env.DB, wrongPlatform.uploadId)).toMatchObject({
      step: 'queued',
      workflowStatus: 'queued',
    });
    expect(await env.BUCKET.head(wrongPlatform.objectKey)).not.toBeNull();
  });

  it.each(['extract', 'analyze', 'dry-run'] as const)(
    'does not access staged objects when authority is revoked before %s',
    async (revokedBefore) => {
      const uploader = await templateAuthor(env, clock, orgId);
      const p = await start(zipOf(basicPackage()), {
        name: `Revoked Before ${revokedBefore}`,
        authority: uploader.authority,
        createdBy: uploader.userId,
      });
      let revoked = false;
      let accessesAfterRevocation = 0;
      const bucket = new Proxy(env.BUCKET, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (prop === 'get' || prop === 'put') {
            return (...args: unknown[]) => {
              if (revoked) accessesAfterRevocation++;
              return value.apply(target, args);
            };
          }
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const step = {
        do: async (name: string, a: unknown, b?: unknown) => {
          if (name === revokedBefore) {
            await run(env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
              clock.now(),
              uploader.membershipId,
            ]);
            revoked = true;
          }
          return ((typeof a === 'function' ? a : b) as () => unknown)();
        },
      } as unknown as WorkflowStep;
      await expect(workflow({ ...env, BUCKET: bucket }).run(event(p), step)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(revoked).toBe(true);
      expect(accessesAfterRevocation).toBe(0);
      expect(await getImport(env.DB, p.uploadId)).toMatchObject({
        step: 'failed',
        error: 'FORBIDDEN',
        workflowStatus: 'errored',
        templateId: null,
      });
    },
  );

  it.each(['x', 'b'] as const)(
    'rechecks authority before every %s staged write',
    async (prefix) => {
      const uploader = await templateAuthor(env, clock, orgId);
      const p = await start(zipOf(basicPackage()), {
        name: `Staged ${prefix} Revocation`,
        authority: uploader.authority,
        createdBy: uploader.userId,
      });
      let revoked = false;
      let writesAfterRevocation = 0;
      const bucket = new Proxy(env.BUCKET, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (prop === 'put') {
            return async (...args: unknown[]) => {
              if (revoked) writesAfterRevocation++;
              const result = await value.apply(target, args);
              if (!revoked && String(args[0]).startsWith(`uploads/${p.uploadId}/${prefix}/`)) {
                await run(env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
                  clock.now(),
                  uploader.membershipId,
                ]);
                revoked = true;
              }
              return result;
            };
          }
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      await expect(
        workflow({ ...env, BUCKET: bucket }).run(event(p), inlineStep([])),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(revoked).toBe(true);
      expect(writesAfterRevocation).toBe(0);
      expect(await getImport(env.DB, p.uploadId)).toMatchObject({
        step: 'failed',
        error: 'FORBIDDEN',
        workflowStatus: 'errored',
        templateId: null,
      });
    },
  );

  it('rejects a revoked membership before writing any template assets', async () => {
    const uploader = await templateAuthor(env, clock, orgId);
    const p = await start(zipOf(basicPackage()), {
      name: 'Revoked Before Persist',
      authority: uploader.authority,
      createdBy: uploader.userId,
    });
    const before = (await env.BUCKET.list({ prefix: `templates/${orgId}/` })).objects.map(
      (object) => object.key,
    );
    const step = {
      do: async (name: string, a: unknown, b?: unknown) => {
        if (name === 'persist') {
          await run(env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
            clock.now(),
            uploader.membershipId,
          ]);
        }
        return ((typeof a === 'function' ? a : b) as () => unknown)();
      },
    } as unknown as WorkflowStep;
    await workflow().run(event(p), step);
    expect(await getImport(env.DB, p.uploadId)).toMatchObject({
      step: 'failed',
      error: 'FORBIDDEN',
      workflowStatus: 'errored',
      templateId: null,
    });
    expect(
      await first(env.DB, "SELECT id FROM templates WHERE slug = 'revoked-before-persist'"),
    ).toBeNull();
    expect(
      (await env.BUCKET.list({ prefix: `templates/${orgId}/` })).objects.map(
        (object) => object.key,
      ),
    ).toEqual(before);
  });

  it.each([
    { existing: false, revoke: 'membership' },
    { existing: true, revoke: 'membership' },
  ] as const)(
    'fences $revoke revocation at the final commit (existing: $existing)',
    async ({ existing, revoke }) => {
      const uploader = await templateAuthor(env, clock, orgId);
      const name = existing ? 'Existing Commit Race' : 'New Commit Race';
      const zip = zipOf(basicPackage());
      const options = { name, authority: uploader.authority, createdBy: uploader.userId };
      let previous: { templateId: string; version: string } | null = null;
      if (existing) {
        const initial = await start(zip, options);
        await workflow().run(event(initial), inlineStep([]));
        const imported = await getImport(env.DB, initial.uploadId);
        if (!imported?.templateId || !imported.version) throw new Error('Initial import failed');
        previous = { templateId: imported.templateId, version: imported.version };
      }
      const p = await start(zip, options);
      const race = beforePersistBatch(() =>
        revoke === 'membership'
          ? run(env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
              clock.now(),
              uploader.membershipId,
            ])
          : run(env.DB, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
              clock.now(),
              uploader.sessionId,
            ]),
      );
      await workflow(race.env).run(event(p), race.step);
      expect(race.hits()).toBe(1);
      expect(await getImport(env.DB, p.uploadId)).toMatchObject({
        step: 'failed',
        error: 'ACTOR_CHANGED',
        workflowStatus: 'errored',
        templateId: null,
        version: null,
      });
      if (previous) {
        expect(
          await first<{ active_version: string | null }>(
            env.DB,
            'SELECT active_version FROM templates WHERE id = ?',
            [previous.templateId],
          ),
        ).toEqual({ active_version: null });
        expect(
          await first<{ n: number }>(
            env.DB,
            'SELECT COUNT(*) AS n FROM template_versions WHERE template_id = ?',
            [previous.templateId],
          ),
        ).toEqual({ n: 1 });
        expect(await getVersion(env.DB, previous.templateId, previous.version)).not.toBeNull();
      } else {
        expect(
          await first(env.DB, "SELECT id FROM templates WHERE slug = 'new-commit-race'"),
        ).toBeNull();
      }
    },
  );

  it('lets an import finish after the uploader signs out (queued work outlives the session)', async () => {
    const uploader = await templateAuthor(env, clock, orgId);
    const p = await start(zipOf(basicPackage()), {
      name: 'Signed Out Import',
      authority: uploader.authority,
      createdBy: uploader.userId,
    });
    const race = beforePersistBatch(() =>
      run(env.DB, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
        clock.now(),
        uploader.sessionId,
      ]),
    );
    await workflow(race.env).run(event(p), race.step);
    expect(race.hits()).toBe(1);
    expect(await getImport(env.DB, p.uploadId)).toMatchObject({
      step: 'done',
      workflowStatus: 'complete',
    });
  });

  it.each(['object', 'failed'] as const)(
    'fences a changed upload %s at the final commit',
    async (change) => {
      const p = await start(zipOf(basicPackage()), { name: `Upload ${change} Race` });
      const race = beforePersistBatch(async () => {
        if (change === 'object') {
          await run(env.DB, 'UPDATE template_imports SET object_key = ? WHERE upload_id = ?', [
            'uploads/substituted.zip',
            p.uploadId,
          ]);
        } else {
          await run(
            env.DB,
            "UPDATE template_imports SET step = 'failed', error = ? WHERE upload_id = ?",
            ['PREEXISTING_FAILURE', p.uploadId],
          );
          await run(
            env.DB,
            "UPDATE workflow_runs SET status = 'errored', error_code = ? WHERE instance_id = ?",
            ['PREEXISTING_FAILURE', p.uploadId],
          );
        }
      });
      await expect(workflow(race.env).run(event(p), race.step)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(race.hits()).toBe(1);
      expect(await getImport(env.DB, p.uploadId)).toMatchObject(
        change === 'object'
          ? { step: 'persist', workflowStatus: 'running', templateId: null, version: null }
          : {
              step: 'failed',
              error: 'PREEXISTING_FAILURE',
              workflowStatus: 'errored',
              templateId: null,
              version: null,
            },
      );
      expect(await env.BUCKET.head(p.objectKey)).not.toBeNull();
      expect(
        await first(env.DB, 'SELECT id FROM templates WHERE slug = ?', [`upload-${change}-race`]),
      ).toBeNull();
    },
  );

  it('does not overwrite a failure recorded after the candidate commit', async () => {
    const p = await start(zipOf(basicPackage()), { name: 'Failure After Commit' });
    const race = beforePersistBatch(async () => {
      await run(
        env.DB,
        "UPDATE template_imports SET step = 'failed', error = ? WHERE upload_id = ?",
        ['PREEXISTING_FAILURE', p.uploadId],
      );
      await run(
        env.DB,
        "UPDATE workflow_runs SET status = 'errored', error_code = ? WHERE instance_id = ?",
        ['PREEXISTING_FAILURE', p.uploadId],
      );
    }, 'after');
    await expect(workflow(race.env).run(event(p), race.step)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(race.hits()).toBe(1);
    expect(await getImport(env.DB, p.uploadId)).toMatchObject({
      step: 'failed',
      error: 'PREEXISTING_FAILURE',
      workflowStatus: 'errored',
      templateId: null,
    });
    expect(
      await first<{ active_version: string | null }>(
        env.DB,
        "SELECT active_version FROM templates WHERE slug = 'failure-after-commit'",
      ),
    ).toEqual({ active_version: null });
  });

  it('does not complete if the uploader is revoked after the candidate commit', async () => {
    const uploader = await templateAuthor(env, clock, orgId);
    const p = await start(zipOf(basicPackage()), {
      name: 'Revoked After Commit',
      authority: uploader.authority,
      createdBy: uploader.userId,
    });
    const race = beforePersistBatch(
      () =>
        run(env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
          clock.now(),
          uploader.membershipId,
        ]),
      'after',
    );
    await workflow(race.env).run(event(p), race.step);
    expect(race.hits()).toBe(1);
    expect(await getImport(env.DB, p.uploadId)).toMatchObject({
      step: 'failed',
      error: 'FORBIDDEN',
      workflowStatus: 'errored',
      templateId: null,
    });
    expect(
      await first<{ active_version: string | null }>(
        env.DB,
        "SELECT active_version FROM templates WHERE slug = 'revoked-after-commit'",
      ),
    ).toEqual({ active_version: null });
  });

  it('does not commit when the template is archived immediately before the batch', async () => {
    const name = 'Archive Commit Race';
    const initial = await start(zipOf(basicPackage()), { name });
    await workflow().run(event(initial), inlineStep([]));
    const imported = await getImport(env.DB, initial.uploadId);
    if (!imported?.templateId) throw new Error('Initial import failed');
    const id = imported.templateId;
    const p = await start(zipOf(basicPackage({ 'logo.png': makePng(120, 40) })), { name });
    const race = beforePersistBatch(() =>
      run(env.DB, "UPDATE templates SET status = 'archived' WHERE id = ?", [id]),
    );
    await workflow(race.env).run(event(p), race.step);
    expect(race.hits()).toBe(1);
    expect(await getImport(env.DB, p.uploadId)).toMatchObject({
      step: 'failed',
      error: 'TEMPLATE_VERSION_CONFLICT',
      workflowStatus: 'errored',
      templateId: null,
    });
    expect(
      await first<{ status: string; active_version: string | null }>(
        env.DB,
        'SELECT status, active_version FROM templates WHERE id = ?',
        [id],
      ),
    ).toEqual({ status: 'archived', active_version: null });
    expect(
      await first<{ n: number }>(
        env.DB,
        'SELECT COUNT(*) AS n FROM template_versions WHERE template_id = ?',
        [id],
      ),
    ).toEqual({ n: 1 });
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

  it('writes the failure only inside named steps', async () => {
    const p = await start(zipOf(basicPackage()));
    const guard = guardWrites(env);
    const names: string[] = [];
    const step = guard.step({
      do: async (name: string, a: unknown, b?: unknown) => {
        names.push(name);
        if (name === 'analyze') throw new Error('boom');
        return ((typeof a === 'function' ? a : b) as () => unknown)();
      },
    }) as unknown as WorkflowStep;
    await expect(workflow(guard.env).run(event(p), step)).rejects.toThrow('boom');
    expect(names).toEqual(['start', 'extract', 'analyze', 'fail-import', 'cleanup-failed']);
    expect(guard.violations).toEqual([]);
  });
});

describe('deferred import authority at the final commit', () => {
  const failsWith = async (
    name: string,
    authority: TemplateAuthority,
    createdBy: string,
    org: string | null,
    code: string,
    intervene: () => Promise<unknown>,
  ) => {
    const p = await start(zipOf(basicPackage()), { name, orgId: org, authority, createdBy });
    const race = beforePersistBatch(intervene);
    await workflow(race.env).run(event(p), race.step);
    expect(race.hits()).toBe(1);
    expect(await getImport(env.DB, p.uploadId)).toMatchObject({
      step: 'failed',
      error: code,
      workflowStatus: 'errored',
      templateId: null,
    });
    expect(
      await first(env.DB, 'SELECT id FROM templates WHERE slug = ?', [
        name.toLowerCase().replace(/ /g, '-'),
      ]),
    ).toBeNull();
  };

  it('stops when the uploader is disabled', async () => {
    const uploader = await templateAuthor(env, clock, orgId);
    await failsWith(
      'Disabled Importer',
      uploader.authority,
      uploader.userId,
      orgId,
      'ACTOR_CHANGED',
      () => run(env.DB, "UPDATE users SET status = 'disabled' WHERE id = ?", [uploader.userId]),
    );
  });

  it('stops when the org is suspended', async () => {
    const other = (await makeOrg(fixtures(env, clock))).id;
    const uploader = await templateAuthor(env, clock, other);
    await failsWith(
      'Suspended Importer',
      uploader.authority,
      uploader.userId,
      other,
      'ORG_ACCESS_CHANGED',
      () => run(env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [other]),
    );
  });

  it('stays stopped when the org is suspended and then reactivated', async () => {
    const other = (await makeOrg(fixtures(env, clock))).id;
    const uploader = await templateAuthor(env, clock, other);
    await failsWith(
      'Reactivated Importer',
      uploader.authority,
      uploader.userId,
      other,
      'ORG_ACCESS_CHANGED',
      async () => {
        await run(env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [other]);
        await run(env.DB, "UPDATE orgs SET status = 'active' WHERE id = ?", [other]);
      },
    );
  });

  it.each(['disabled', 'demoted', 're-enabled'] as const)(
    'stops when a platform importer is %s',
    async (change) => {
      const f = fixtures(env, clock);
      const user = await makeUser(f);
      await setAdmin(user.id);
      const session = await makeSession(f, { userId: user.id, roles: ['admin', 'user'] });
      const auth = await createSessionStore(env, clock).resolve(session.cookieValue);
      if (!auth) throw new Error('The platform session did not resolve');
      const authority = await authorizeTemplateWrite(
        createServiceContext(env, { clock }),
        auth,
        null,
        'templates:author',
      );
      await failsWith(
        `Platform ${change} Importer`,
        authority,
        user.id,
        null,
        'ACTOR_CHANGED',
        async () => {
          if (change === 'demoted') {
            await run(env.DB, "UPDATE users SET last_roles = '[]' WHERE id = ?", [user.id]);
            return;
          }
          await run(env.DB, "UPDATE users SET status = 'disabled' WHERE id = ?", [user.id]);
          // Disabled and enabled again before the commit: the revision captured at upload moved on.
          if (change === 're-enabled')
            await run(env.DB, "UPDATE users SET status = 'active' WHERE id = ?", [user.id]);
        },
      );
    },
  );
});
