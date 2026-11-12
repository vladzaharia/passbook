import { OpenAPIHono } from '@hono/zod-openapi';
import { unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type ApiKeyFixture,
  makeApiKey,
  makeOrg,
  makeSession,
  makeUser,
  type SessionFixture,
  type UserRow,
} from '../../../../test/helpers/index.ts';
import type { OrgRole } from '../../../shared/contracts/org-membership.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { type AppBindings, requestContext } from '../../platform/context.ts';
import { credentialAad, encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import { all, first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { claimSnapshot, finishItem, startNewItem } from '../connections/repo-webhook-items.ts';
import { insertStagedWebhook, type RetainedRow } from '../connections/repo-webhook-retention.ts';
import { retainedWebhookRefHash } from '../connections/webhook-claim-ref.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import {
  EMAIL_RECIPIENT_HOURLY_CAP,
  recoverIssuanceDeliveries,
} from '../delivery/issuance-intent.ts';
import { handleEmailSend } from '../delivery/jobs.ts';
import { assignHolder, runAttachHookA } from '../holders/service.ts';
import { PLATFORM_IDENTITY_ID } from '../identities/resolver.ts';
import { basicPackage, passJson, zipOf } from '../templates/package/fixtures.ts';
import { type CompositeTemplateRegistry, createTemplateRegistry } from '../templates/registry.ts';
import { activeRelease, type TemplateRelease as Release } from '../templates/releases.ts';
import { generatedSource, resetBakedSync, syncBakedTemplates } from '../templates/sync.ts';
import {
  type BakedFixture,
  bakedFrom,
  fakeAssets,
  importZip,
  sourceOf,
} from '../templates/testing.ts';
import { createPassFromConnection } from './connection-passes-create.ts';
import { createPassIdempotent, createPassRow } from './create.ts';
import type { CreateParams } from './create-types.ts';
import { ensureCredentialRefKeyset } from './credential-keyset.ts';
import { finishCredentialTransfer } from './credential-transfer.ts';
import { overrideDeps } from './deps.ts';
import {
  authOf,
  requireTenantSessionOrApiKey,
  type TenantPassWrite,
  tenantAuthorityOf,
} from './http.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import type { Pass } from './repo.ts';
import { tenantPassAuthorityValid } from './repo-authority.ts';
import { getPass, getPassByDownloadToken } from './repo-read-pass.ts';
import { approvedReleaseFence } from './repo-release.ts';
import { makeTenantTestApiKey } from './repo-tenant-test-fixtures.ts';
import { insertPass } from './repo-write.ts';
import type { NewPassRow } from './repo-write-types.ts';

const ORIGIN = 'https://wallet.test';
const originalGeneratedSource = { ...generatedSource };
type Mode = 'live' | 'test';
interface Member {
  user: UserRow;
  membershipId: string;
  session: SessionFixture;
}
type Workspace = {
  orgId: string;
  author: Member;
  reviewer: Member;
  publisher: Member;
  operator: Member;
};
type Imported = { templateId: string; version: string; name: string };

let kit: Kit;

/** Connection setup is a system path: it needs a job context, bound to the database the test races. */
const jobAt = (db: D1Database) => ({ ...jobCtxOf(kit), env: { ...kit.env, DB: db } });
let credentialKeysetCommitment: string;
let app: OpenAPIHono<AppBindings>;
let own: Workspace;
let foreign: Workspace;
let baked: BakedFixture;
let bakedRace: BakedFixture;
let registry: CompositeTemplateRegistry;

const unique = () => kit.fx.ids.token(12);

async function member(orgId: string, roles: OrgRole[]) {
  const user = await makeUser(kit.fx);
  const id = kit.fx.ids.id();
  const invitationId = kit.fx.ids.id();
  const now = kit.clock.now();
  await run(
    kit.env.DB,
    `INSERT INTO org_invitations
    (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      invitationId,
      orgId,
      user.primaryEmail,
      JSON.stringify(roles),
      await sha256Hex(unique()),
      now,
      now + 60_000,
      now,
    ],
  );
  await run(
    kit.env.DB,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`,
    [id, orgId, user.id, invitationId, JSON.stringify(roles), now],
  );
  const session = await makeSession(kit.fx, { userId: user.id, roles: ['user'] });
  return { user, membershipId: id, session };
}

async function workspace(name: string): Promise<Workspace> {
  const { id: orgId } = await makeOrg(kit.fx, { name });
  return {
    orgId,
    author: await member(orgId, ['template_author']),
    reviewer: await member(orgId, ['template_reviewer']),
    publisher: await member(orgId, ['template_publisher']),
    operator: await member(orgId, ['pass_operator']),
  };
}

/** Capture the same key scope that the real tenant HTTP guard grants. */
async function keyAuthority(key: ApiKeyFixture, orgId: string): Promise<TenantPassWrite> {
  const scoped = new OpenAPIHono<AppBindings>();
  const capture: { value: TenantPassWrite | null } = { value: null };
  scoped.use(
    '*',
    requestContext({
      clock: kit.clock,
      stores: (env) => ({
        ...denyAllStores,
        sessions: createSessionStore(env, kit.clock),
        apiKeys: createApiKeyStore(env, kit.clock),
      }),
    }),
  );
  scoped.post('/capture', requireTenantSessionOrApiKey('passes:write'), async (c) => {
    capture.value = await tenantAuthorityOf(serviceContext(c), authOf(c), orgId, 'passes:operate');
    return c.json({ ok: true });
  });
  const response = await scoped.request(
    `${ORIGIN}/capture`,
    { method: 'POST', headers: key.headers },
    kit.env,
  );
  expect(response.status).toBe(200);
  if (!capture.value) throw new Error('Real API key did not acquire tenant scope');
  return capture.value;
}

function packageFor(name: string, revision = 1, staticBarcode = false) {
  const manifest = {
    schema: 1,
    name,
    description: `Revision ${revision}`,
    inputs: {
      type: 'object',
      required: ['memberName'],
      properties: { memberName: { type: 'string', minLength: 1 } },
    },
    sample: { memberName: 'Approved member' },
    bindings: [{ to: { field: 'name' }, value: '{{memberName}}' }],
    display: { title: '{{memberName}}' },
  };
  return basicPackage(
    { 'wallet.template.json': JSON.stringify(manifest) },
    passJson(
      staticBarcode
        ? {
            barcodes: [
              { format: 'PKBarcodeFormatQR', message: 'MEMBER123', messageEncoding: 'iso-8859-1' },
            ],
          }
        : {},
    ),
  );
}

beforeAll(async () => {
  resetBakedSync();
  kit = await setupKit({ approvedReleases: false });
  kit.env.KEK_V1 = btoa('0123456789abcdef0123456789abcdef');
  credentialKeysetCommitment = await ensureCredentialRefKeyset(kit.env.DB, kit.env);
  const assets = fakeAssets();
  Object.assign(kit.env, { ASSETS: assets });
  baked = await bakedFrom(`approved-${unique()}`, packageFor('Global approved starter'));
  bakedRace = await bakedFrom(`approved-race-${unique()}`, packageFor('Global reassigned starter'));
  for (const fixture of [baked, bakedRace])
    for (const [path, bytes] of fixture.files) assets.files.set(path, bytes);
  const source = sourceOf([baked, bakedRace], `approved-issuance-${unique()}`);
  // The real sync and release lookup both read the generated source; supply genuine baked fixtures.
  Object.assign(generatedSource, source);
  await syncBakedTemplates(jobCtxOf(kit));
  registry = createTemplateRegistry(kit.env, { source, ctx: jobCtxOf(kit) });
  overrideDeps(kit.env, { registry });
  app = createApp({
    stores: (env) => ({
      ...denyAllStores,
      sessions: createSessionStore(env, kit.clock),
      apiKeys: createApiKeyStore(env, kit.clock),
    }),
    clock: kit.clock,
  });
  own = await workspace('Approved issue tenant');
  foreign = await workspace('Other approved issue tenant');
}, 60_000);

afterAll(() => {
  Object.assign(generatedSource, originalGeneratedSource);
  resetBakedSync();
});

async function imported(
  ws: Workspace,
  name = `Approved ${unique()}`,
  revision = 1,
  staticBarcode = false,
): Promise<Imported> {
  const result = await importZip(kit.env, kit.clock, {
    orgId: ws.orgId,
    name,
    zip: zipOf(packageFor(name, revision, staticBarcode)),
    createdBy: ws.author.user.id,
  });
  if (!result.result) throw new Error(`Template import failed at ${result.stages.join(', ')}`);
  return { ...result.result, name };
}

async function templatePost(path: string, who: Member, mode: Mode, body: object) {
  return app.request(
    `${ORIGIN}/api/v1/templates${path}`,
    {
      method: 'POST',
      headers: {
        ...who.session.headers,
        ...(mode === 'test' ? { 'x-passbook-mode': 'test' } : {}),
        origin: ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    kit.env,
  );
}

async function created<T>(response: Response): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(201);
  return response.json() as Promise<T>;
}

/** An actual imported version, distinct author/reviewer, and the real approval/publish routes. */
async function publish(ws: Workspace, template: Imported, mode: Mode = 'live', generation = 0) {
  kit.clock.advance(1);
  const path = `/${encodeURIComponent(template.templateId)}`;
  const scope = { orgId: ws.orgId, mode, provider: 'apple' as const };
  const candidate = await created<{ id: string; candidateHash: string }>(
    await templatePost(`${path}/candidates`, ws.author, mode, {
      ...scope,
      version: template.version,
    }),
  );
  expect(candidate.candidateHash).toMatch(/^[0-9a-f]{64}$/);
  const approval = await created<{ id: string; candidateId: string; candidateHash: string }>(
    await templatePost(
      `${path}/candidates/${encodeURIComponent(candidate.id)}/approve`,
      ws.reviewer,
      mode,
      { ...scope, candidateHash: candidate.candidateHash },
    ),
  );
  expect(approval).toMatchObject({
    candidateId: candidate.id,
    candidateHash: candidate.candidateHash,
  });
  const release = await created<Release>(
    await templatePost(`${path}/releases`, ws.publisher, mode, {
      ...scope,
      candidateId: candidate.id,
      approvalId: approval.id,
      candidateHash: candidate.candidateHash,
      expectedGeneration: generation,
    }),
  );
  expect(release).toMatchObject({
    templateId: template.templateId,
    orgId: ws.orgId,
    mode,
    provider: 'apple',
    version: template.version,
    candidateHash: candidate.candidateHash,
    generation: generation + 1,
  });
  return release;
}

async function approved(ws = own, mode: Mode = 'live') {
  const template = await imported(ws);
  return { template, release: await publish(ws, template, mode) };
}

function body(ws: Workspace, release: Release, externalId = unique()) {
  return {
    orgId: ws.orgId,
    templateId: release.templateId,
    templateVersion: release.version,
    releaseId: release.id,
    releaseGeneration: release.generation,
    mode: release.mode,
    input: { memberName: 'Approved member' },
    externalId,
  };
}

async function issue(headers: Record<string, string>, data: object, key: string) {
  return app.request(
    `${ORIGIN}/api/v1/passes`,
    {
      method: 'POST',
      headers: {
        ...headers,
        origin: ORIGIN,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify(data),
    },
    kit.env,
  );
}

const reservation = (orgId: string, key: string, db = kit.env.DB) =>
  first<{ resource_id: string; request_hash: string }>(
    db,
    'SELECT resource_id, request_hash FROM idempotency_keys WHERE org_id = ? AND key = ?',
    [orgId, key],
  );

async function objects() {
  return (await kit.env.BUCKET.list({ prefix: 'passes/' })).objects
    .map((object) => object.key)
    .sort();
}

async function assertNoIssue(ws: Workspace, externalId: string, key: string, before: string[]) {
  expect(
    await first(kit.env.DB, 'SELECT id FROM passes WHERE org_id = ? AND external_id = ?', [
      ws.orgId,
      externalId,
    ]),
  ).toBeNull();
  expect(await reservation(ws.orgId, key)).toBeNull();
  expect(await objects()).toEqual(before);
}

async function assertNoPassRows(passId: string) {
  expect(passId).toBeTruthy();
  expect(await getPass(kit.env.DB, passId)).toBeNull();
  expect(await first(kit.env.DB, 'SELECT id FROM passes WHERE id = ?', [passId])).toBeNull();
  expect(await all(kit.env.DB, 'SELECT * FROM pass_versions WHERE pass_id = ?', [passId])).toEqual(
    [],
  );
  expect(await all(kit.env.DB, 'SELECT id FROM pass_events WHERE pass_id = ?', [passId])).toEqual(
    [],
  );
  expect(await all(kit.env.DB, 'SELECT id FROM outbox WHERE pass_id = ?', [passId])).toEqual([]);
  expect(
    await all(kit.env.DB, "SELECT id FROM audit_log WHERE target_type = 'pass' AND target_id = ?", [
      passId,
    ]),
  ).toEqual([]);
}

async function assertNoPass(passId: string) {
  await assertNoPassRows(passId);
  expect((await kit.env.BUCKET.list({ prefix: `passes/${passId}/` })).objects).toHaveLength(0);
}

async function assertIssued(passId: string, ws: Workspace, release: Release) {
  const row = await first<{
    org_id: string;
    mode: string;
    template_id: string;
    template_version: string;
    release_id: string;
    object_key: string;
  }>(
    kit.env.DB,
    `SELECT org_id, mode, template_id, template_version, release_id, object_key
    FROM passes WHERE id = ?`,
    [passId],
  );
  expect(row).toMatchObject({
    org_id: ws.orgId,
    mode: release.mode,
    template_id: release.templateId,
    template_version: release.version,
    release_id: release.id,
  });
  if (!row) throw new Error('Issued pass not found');
  expect(
    await first(
      kit.env.DB,
      `SELECT id, generation, template_id, org_id, mode, provider, version, candidate_hash
    FROM template_releases WHERE id = ?`,
      [release.id],
    ),
  ).toMatchObject({
    id: release.id,
    generation: release.generation,
    template_id: release.templateId,
    org_id: release.orgId,
    mode: release.mode,
    provider: release.provider,
    version: release.version,
    candidate_hash: release.candidateHash,
  });
  expect(await kit.env.BUCKET.head(row.object_key)).not.toBeNull();
  expect(
    await first(
      kit.env.DB,
      "SELECT id FROM audit_log WHERE action = 'pass.create' AND target_type = 'pass' AND target_id = ?",
      [passId],
    ),
  ).not.toBeNull();
  expect(
    await first(
      kit.env.DB,
      "SELECT id FROM pass_events WHERE kind = 'pass.issued' AND pass_id = ?",
      [passId],
    ),
  ).not.toBeNull();
}

/** Interleave a real D1 mutation at the last statement, including batched statements. */
async function atMutation<T>(
  table: 'passes' | 'pass_events' | 'outbox' | 'idempotency_keys',
  change: (db: D1Database) => Promise<void>,
  call: () => Promise<T>,
  expected = 1,
) {
  const db = kit.env.DB;
  const statements = new WeakMap<
    D1PreparedStatement,
    { sql: string; native: D1PreparedStatement }
  >();
  let intercepted = 0;
  const intervene = async (sql: string) => {
    if (
      !intercepted &&
      new RegExp(`^\\s*INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+${table}\\b`, 'i').test(sql)
    ) {
      intercepted++;
      await change(db);
    }
  };
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, prop) {
        if (prop === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (prop === 'first')
          return async (column?: string) => {
            await intervene(sql);
            return column === undefined ? target.first() : target.first(column);
          };
        if (prop === 'run')
          return async () => {
            await intervene(sql);
            return target.run();
          };
        if (prop === 'all')
          return async () => {
            await intervene(sql);
            return target.all();
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    statements.set(wrapped, { sql, native: statement });
    return wrapped;
  };
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
      if (prop === 'batch')
        return async (batch: D1PreparedStatement[]) => {
          for (const statement of batch) await intervene(statements.get(statement)?.sql ?? '');
          return target.batch(
            batch.map((statement) => statements.get(statement)?.native ?? statement),
          );
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.assign(kit.env, { DB: proxy });
  try {
    return await call();
  } finally {
    Object.assign(kit.env, { DB: db });
    expect(intercepted, `the ${table} insert count`).toBe(expected);
  }
}

/** Both entry points must refuse the actor before executing a reservation or pass INSERT. */
async function expectEarlyDenied(input: CreateParams, status: number, code: string) {
  if (!input.passId || !input.externalId)
    throw new Error('An observable pass id and external id are required');
  const before = await objects();
  const key = unique();
  const unexpected = async () => {
    throw new Error('Unauthorized issuance reached a D1 write');
  };
  await expect(
    atMutation('passes', unexpected, () => createPassRow(jobCtxOf(kit), input), 0),
  ).rejects.toMatchObject({ status, code });
  await assertNoPass(input.passId);
  await expect(
    atMutation(
      'idempotency_keys',
      unexpected,
      () => createPassIdempotent(jobCtxOf(kit), input, key),
      0,
    ),
  ).rejects.toMatchObject({ status, code });
  await assertNoIssue(own, input.externalId, key, before);
}

/** Mutate real credentials while the real artifact builder is reading a template asset. */
async function duringBuild<T>(change: () => Promise<void>, call: () => Promise<T>) {
  let intercepted = 0;
  overrideDeps(kit.env, {
    registry: {
      list: (query) => registry.list(query),
      resolve: (id, version) => registry.resolve(id, version),
      async openAsset(template, name) {
        if (!intercepted) {
          intercepted++;
          await change();
        }
        return registry.openAsset(template, name);
      },
    },
  });
  try {
    const result = await call();
    expect(intercepted, 'the signed artifact build read an asset').toBe(1);
    return result;
  } finally {
    overrideDeps(kit.env, { registry });
  }
}

async function pendingPassId(before: string[]) {
  const previous = new Set(before);
  const added = (await objects()).filter((key) => !previous.has(key));
  expect(added).toHaveLength(1);
  const passId = added[0]?.split('/')[1];
  if (!passId) throw new Error('The built pass object was not uploaded before the insert');
  return passId;
}

describe('approved issuance over tenant HTTP', () => {
  it.each(['session', 'api key'] as const)(
    'persists the exact reviewed release for a real %s',
    async (kind) => {
      const { release } = await approved();
      const key = unique();
      const credential =
        kind === 'session'
          ? own.operator.session.headers
          : (await makeApiKey(kit.fx, { orgId: own.orgId, scopes: ['passes:write'] })).headers;
      const data = body(own, release);
      const response = await issue(credential, data, key);
      expect(response.status, await response.clone().text()).toBe(201);
      const { id } = (await response.json()) as { id: string };
      await assertIssued(id, own, release);
      expect(await reservation(own.orgId, key)).toMatchObject({ resource_id: id });
      const replay = await issue(credential, data, key);
      expect(replay.status).toBe(201);
      expect(await replay.json()).toMatchObject({ id });
    },
    60_000,
  );

  it('atomically issues to a verified holder and delivers the initially issued credentials', async () => {
    const template = await imported(own, `Static barcode ${unique()}`, 1, true);
    const release = await publish(own, template);
    const email = `holder-${unique()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, 'x')}@example.com`;
    const user = await makeUser(kit.fx, { primaryEmail: email });
    const key = unique();
    let source: Pass | null = null;
    const sent = kit.mailer.sent.length;
    const orgKey = `pass-email:live:org:${own.orgId}`;
    const orgWindow = kit.clock.now() - (kit.clock.now() % 86_400_000);
    const orgCounter = await first<{ count: number }>(
      kit.env.DB,
      'SELECT count FROM counters WHERE key = ? AND window_start = ?',
      [orgKey, orgWindow],
    );
    const response = await atMutation(
      'outbox',
      async (db) => {
        const claim = await reservation(own.orgId, key, db);
        if (!claim) throw new Error('Expected an issuance reservation');
        source = await getPass(db, claim.resource_id);
      },
      () =>
        issue(
          own.operator.session.headers,
          {
            ...body(own, release),
            holderEmail: email,
            sendEmail: true,
          },
          key,
        ),
    );
    expect(response.status, await response.clone().text()).toBe(201);
    const detail = (await response.json()) as {
      id: string;
      ownerUserId: string;
      holderState: string;
      publicUrl: string;
    };
    const initial = source as Pass | null;
    if (!initial) throw new Error('Missing initially issued pass');
    const current = await getPass(kit.env.DB, detail.id);
    if (!current) throw new Error('Missing issued pass');
    expect(detail).toMatchObject({ ownerUserId: user.id, holderState: 'owned' });
    expect(detail.publicUrl).toContain(current.downloadToken);
    expect(initial.ownerUserId).toBe(user.id);
    expect(current).toMatchObject({
      ownerUserId: user.id,
      holderEmail: email,
      credentialGeneration: 1,
      lifecycleGeneration: 0,
      linkGeneration: 1,
      version: 1,
      downloadToken: initial.downloadToken,
      serial: initial.serial,
      authToken: initial.authToken,
      scanCode: initial.scanCode,
      objectKey: initial.objectKey,
    });
    expect(
      await all(kit.env.DB, 'SELECT id FROM pass_credential_transfers WHERE pass_id = ?', [
        detail.id,
      ]),
    ).toEqual([]);
    const audits = await all<{ detail: string }>(
      kit.env.DB,
      "SELECT detail FROM audit_log WHERE action = 'holder.attach' AND target_id = ?",
      [detail.id],
    );
    expect(audits).toHaveLength(1);
    expect(JSON.parse(audits[0]?.detail ?? '{}')).toMatchObject({ via: 'email', userId: user.id });
    const artifact = await kit.env.BUCKET.get(current.objectKey);
    if (!artifact) throw new Error('Missing issued pass artifact');
    const files = unzipSync(new Uint8Array(await artifact.arrayBuffer()));
    const passJson = JSON.parse(new TextDecoder().decode(files['pass.json'])) as {
      serialNumber: string;
      authenticationToken: string;
      barcodes: { message: string }[];
    };
    expect(passJson).toMatchObject({
      serialNumber: current.serial,
      authenticationToken: current.authToken,
    });
    expect(passJson.barcodes[0]?.message).toBe('MEMBER123');
    const outboxes = await all<{ id: string; payload: string }>(
      kit.env.DB,
      "SELECT id, payload FROM outbox WHERE kind = 'email' AND pass_id = ?",
      [detail.id],
    );
    expect(outboxes).toHaveLength(1);
    const queued = outboxes[0];
    if (!queued) throw new Error('Missing issuance email');
    expect(
      await first(
        kit.env.DB,
        'SELECT state, outbox_id FROM pass_issuance_deliveries WHERE pass_id = ?',
        [detail.id],
      ),
    ).toEqual({ state: 'queued', outbox_id: queued.id });
    const recipient = (await sha256Hex(`pass-email:${email.toLowerCase()}`)).slice(0, 32);
    expect(
      await first(kit.env.DB, 'SELECT count FROM counters WHERE key = ? AND window_start = ?', [
        `pass-email:live:to:${recipient}`,
        kit.clock.now() - (kit.clock.now() % 3_600_000),
      ]),
    ).toEqual({ count: 1 });
    expect(
      await first(kit.env.DB, 'SELECT count FROM counters WHERE key = ? AND window_start = ?', [
        orgKey,
        orgWindow,
      ]),
    ).toEqual({ count: (orgCounter?.count ?? 0) + 1 });
    const payload = JSON.parse(queued.payload) as {
      to: string;
      intent: {
        pass: {
          version: number;
          linkGeneration: number;
          objectKey: string;
          downloadTokenHash: string;
        };
      };
    };
    expect(payload.to).toBe(email);
    expect(payload.intent.pass).toMatchObject({
      version: current.version,
      linkGeneration: current.linkGeneration,
      objectKey: current.objectKey,
      downloadTokenHash: await sha256Hex(current.downloadToken),
    });
    await handleEmailSend({ kind: 'email.send', outboxId: queued.id }, jobCtxOf(kit));
    expect(kit.mailer.sent).toHaveLength(sent + 1);
    expect(kit.mailer.sent.at(-1)).toMatchObject({ to: email });
    expect(kit.mailer.sent.at(-1)?.html).toContain(current.downloadToken);
  }, 60_000);

  it('rolls back the pass and delivery intent if the initial holder audit cannot commit', async () => {
    const { release } = await approved();
    const email = `audit-${unique()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, 'x')}@example.com`;
    await makeUser(kit.fx, { primaryEmail: email });
    const passId = kit.fx.ids.id();
    const before = await objects();
    await run(
      kit.env.DB,
      `CREATE TRIGGER fail_initial_holder_attach BEFORE INSERT ON audit_log
      WHEN NEW.action = 'holder.attach' AND NEW.target_id = '${passId}'
      BEGIN SELECT RAISE(ABORT, 'holder audit unavailable'); END`,
    );
    try {
      await expect(
        createPassRow(jobCtxOf(kit), {
          orgId: own.orgId,
          templateId: release.templateId,
          templateVersion: release.version,
          releaseId: release.id,
          releaseGeneration: release.generation,
          input: { memberName: 'Audit failure' },
          holderEmail: email,
          sendEmail: true,
          source: 'manual',
          mode: 'live',
          execution: { kind: 'system' },
          actor: { type: 'system', id: null },
          passId,
        }),
      ).rejects.toThrow();
    } finally {
      await run(kit.env.DB, 'DROP TRIGGER fail_initial_holder_attach');
    }
    const artifacts = (await kit.env.BUCKET.list({ prefix: `passes/${passId}/` })).objects.map(
      (object) => object.key,
    );
    try {
      await assertNoPassRows(passId);
      expect(
        await first(kit.env.DB, 'SELECT pass_id FROM pass_issuance_deliveries WHERE pass_id = ?', [
          passId,
        ]),
      ).toBeNull();
      // Unknown D1 failures retain the uploaded object until GC can prove it is orphaned.
      expect(artifacts).toHaveLength(1);
      expect(await objects()).toEqual([...before, ...artifacts].sort());
    } finally {
      if (artifacts.length) await kit.env.BUCKET.delete(artifacts);
    }
  }, 60_000);

  it('retains a committed artifact and recovers its email after an ambiguous D1 response', async () => {
    const { release } = await approved();
    const email = `lost-response-${unique()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, 'x')}@example.com`;
    const passId = kit.fx.ids.id();
    const db = kit.env.DB;
    const statements = new WeakMap<
      D1PreparedStatement,
      { sql: string; native: D1PreparedStatement }
    >();
    const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
      const wrapped = new Proxy(statement, {
        get(target, prop) {
          if (prop === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), sql);
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      statements.set(wrapped, { sql, native: statement });
      return wrapped;
    };
    let lostResponse = false;
    const proxy = new Proxy(db, {
      get(target, prop) {
        if (prop === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
        if (prop === 'batch')
          return async (batch: D1PreparedStatement[]) => {
            const entries = batch.map((statement) => statements.get(statement));
            const result = await target.batch(
              batch.map((statement) => statements.get(statement)?.native ?? statement),
            );
            if (
              !lostResponse &&
              entries.some((entry) => /^\s*INSERT\s+INTO\s+passes\b/i.test(entry?.sql ?? ''))
            ) {
              lostResponse = true;
              throw new Error('D1 response lost after commit');
            }
            return result;
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    Object.assign(kit.env, { DB: proxy });
    try {
      await expect(
        createPassRow(jobCtxOf(kit), {
          orgId: own.orgId,
          templateId: release.templateId,
          templateVersion: release.version,
          releaseId: release.id,
          releaseGeneration: release.generation,
          input: { memberName: 'Lost response' },
          holderEmail: email,
          sendEmail: true,
          source: 'manual',
          mode: 'live',
          execution: { kind: 'system' },
          actor: { type: 'system', id: null },
          passId,
        }),
      ).rejects.toThrow('D1 response lost after commit');
    } finally {
      Object.assign(kit.env, { DB: db });
    }
    expect(lostResponse).toBe(true);
    const pass = await getPass(db, passId);
    if (!pass) throw new Error('The committed pass was lost');
    expect(await kit.env.BUCKET.head(pass.objectKey)).not.toBeNull();
    expect(
      await first(db, 'SELECT state FROM pass_issuance_deliveries WHERE pass_id = ?', [passId]),
    ).toEqual({ state: 'pending' });
    await recoverIssuanceDeliveries(jobCtxOf(kit), passId);
    const queued = await all<{ id: string }>(
      db,
      "SELECT id FROM outbox WHERE kind = 'email' AND pass_id = ?",
      [passId],
    );
    expect(queued).toHaveLength(1);
    if (!queued[0]) throw new Error('Committed issuance email was lost');
    await handleEmailSend({ kind: 'email.send', outboxId: queued[0].id }, jobCtxOf(kit));
    expect(kit.mailer.sent.at(-1)).toMatchObject({ to: email });
    expect(kit.mailer.sent.at(-1)?.html).toContain(pass.downloadToken);
  }, 60_000);

  it('selects a newly verified holder in the issuance INSERT, without a transfer', async () => {
    const { release } = await approved();
    const email = `verified-${unique()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, 'x')}@example.com`;
    const user = await makeUser(kit.fx, { primaryEmail: email, verified: false });
    const key = unique();
    const response = await atMutation(
      'passes',
      async (db) => {
        await run(
          db,
          "INSERT INTO user_emails (email, user_id, verified_via, verified_at) VALUES (?, ?, 'admin', ?)",
          [email, user.id, kit.clock.now()],
        );
      },
      () =>
        issue(
          own.operator.session.headers,
          {
            ...body(own, release),
            holderEmail: email,
            sendEmail: true,
          },
          key,
        ),
    );
    expect(response.status, await response.clone().text()).toBe(201);
    const detail = (await response.json()) as {
      id: string;
      ownerUserId: string;
      holderState: string;
    };
    expect(detail).toMatchObject({ ownerUserId: user.id, holderState: 'owned' });
    expect(await getPass(kit.env.DB, detail.id)).toMatchObject({
      ownerUserId: user.id,
      credentialGeneration: 1,
      linkGeneration: 1,
      version: 1,
    });
    expect(
      await all(kit.env.DB, 'SELECT id FROM pass_credential_transfers WHERE pass_id = ?', [
        detail.id,
      ]),
    ).toEqual([]);
    expect(
      await all(
        kit.env.DB,
        "SELECT id FROM audit_log WHERE action = 'holder.attach' AND target_id = ?",
        [detail.id],
      ),
    ).toHaveLength(1);
    expect(
      await all(kit.env.DB, "SELECT id FROM outbox WHERE kind = 'email' AND pass_id = ?", [
        detail.id,
      ]),
    ).toHaveLength(1);
  }, 60_000);

  it('does not issue a serial retired by a completed holder transfer', async () => {
    const { release } = await approved();
    const serial = `retired-${unique()}`;
    const issueInput: CreateParams = {
      orgId: own.orgId,
      templateId: release.templateId,
      templateVersion: release.version,
      releaseId: release.id,
      releaseGeneration: release.generation,
      input: { memberName: 'Former holder' },
      serial,
      source: 'manual',
      mode: 'live',
      execution: { kind: 'system' },
      actor: { type: 'system', id: null },
    };
    const original = await createPassRow(jobCtxOf(kit), issueInput);
    await assignHolder(
      jobCtxOf(kit),
      { type: 'system', id: null },
      {
        passId: original.id,
        email: `next-${unique()
          .toLowerCase()
          .replace(/[^a-z0-9]/g, 'x')}@example.com`,
      },
      null,
    );
    const moved = await getPass(kit.env.DB, original.id);
    if (!moved) throw new Error('Missing transferred pass');
    expect(moved.serial).not.toBe(serial);
    const before = await objects();
    const attemptedId = kit.fx.ids.id();
    await expect(
      createPassRow(jobCtxOf(kit), { ...issueInput, passId: attemptedId }),
    ).rejects.toMatchObject({ code: 'PASS_REISSUE_REQUIRED' });
    await assertNoPass(attemptedId);
    expect(await objects()).toEqual(before);
  }, 60_000);

  it.each(['unverified', 'disabled'] as const)(
    'leaves an owner %s at the issuance INSERT waiting and still delivers the correct link',
    async (kind) => {
      const { release } = await approved();
      const email = `waiting-${unique()
        .toLowerCase()
        .replace(/[^a-z0-9]/g, 'x')}@example.com`;
      const user = await makeUser(kit.fx, { primaryEmail: email });
      const key = unique();
      const response = await atMutation(
        'passes',
        async (db) => {
          if (kind === 'unverified')
            await run(db, 'DELETE FROM user_emails WHERE user_id = ?', [user.id]);
          else await run(db, "UPDATE users SET status = 'disabled' WHERE id = ?", [user.id]);
        },
        () =>
          issue(
            own.operator.session.headers,
            {
              ...body(own, release),
              holderEmail: email,
              sendEmail: true,
            },
            key,
          ),
      );
      expect(response.status, await response.clone().text()).toBe(201);
      const detail = (await response.json()) as {
        id: string;
        ownerUserId: string | null;
        holderState: string;
      };
      expect(detail).toMatchObject({ ownerUserId: null, holderState: 'waiting' });
      const pass = await getPass(kit.env.DB, detail.id);
      if (!pass) throw new Error('Missing issued pass');
      expect(pass).toMatchObject({
        ownerUserId: null,
        credentialGeneration: 1,
        linkGeneration: 1,
        version: 1,
      });
      expect(
        await all(kit.env.DB, 'SELECT id FROM pass_credential_transfers WHERE pass_id = ?', [
          detail.id,
        ]),
      ).toEqual([]);
      expect(
        await all(
          kit.env.DB,
          "SELECT id FROM audit_log WHERE action = 'holder.attach' AND target_id = ?",
          [detail.id],
        ),
      ).toEqual([]);
      const rows = await all<{ id: string }>(
        kit.env.DB,
        "SELECT id FROM outbox WHERE kind = 'email' AND pass_id = ?",
        [detail.id],
      );
      expect(rows).toHaveLength(1);
      if (!rows[0]) throw new Error('Missing issuance email');
      await handleEmailSend({ kind: 'email.send', outboxId: rows[0].id }, jobCtxOf(kit));
      expect(kit.mailer.sent.at(-1)).toMatchObject({ to: email });
      expect(kit.mailer.sent.at(-1)?.html).toContain(pass.downloadToken);
    },
    60_000,
  );

  it('durably resumes issuance delivery after a concurrent verified attachment waits for rotation', async () => {
    const { template, release } = await approved();
    const email = `pending-${unique()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, 'x')}@example.com`;
    const user = await makeUser(kit.fx, { primaryEmail: email, verified: false });
    const key = unique();
    const data = { ...body(own, release), holderEmail: email, sendEmail: true };
    let passId = '';
    let transferId = '';
    let source: Pass | null = null;
    let failedWrite = false;
    const sent = kit.mailer.sent.length;
    const response = await atMutation(
      'outbox',
      async (db) => {
        const claim = await reservation(own.orgId, key, db);
        if (!claim) throw new Error('Expected an issuance reservation');
        passId = claim.resource_id;
        source = await getPass(db, passId);
        await run(
          db,
          "INSERT INTO user_emails (email, user_id, verified_via, verified_at) VALUES (?, ?, 'admin', ?)",
          [email, user.id, kit.clock.now()],
        );
        const bucket = kit.env.BUCKET;
        const proxy = new Proxy(bucket, {
          get(target, prop) {
            if (prop === 'put') {
              const put = target.put.bind(target);
              return (...args: Parameters<typeof put>) => {
                if (String(args[0]).startsWith(`passes/${passId}/v2-`)) {
                  failedWrite = true;
                  throw new Error('temporary artifact storage failure');
                }
                return put(...args);
              };
            }
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        Object.assign(kit.env, { BUCKET: proxy });
        try {
          const attach = await runAttachHookA(jobCtxOf(kit), passId);
          if (!attach) throw new Error('Expected the verified attachment to start');
          expect(attach.state).toBe('pending');
          if (!attach.transferId) throw new Error('Expected a transfer');
          transferId = attach.transferId;
        } finally {
          Object.assign(kit.env, { BUCKET: bucket });
        }
      },
      () => issue(own.operator.session.headers, data, key),
    );
    const initial = source as Pass | null;
    if (!initial) throw new Error('Missing issued source pass');
    expect(initial.ownerUserId).toBeNull();
    expect(failedWrite).toBe(true);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'PASS_TRANSFER_PENDING' });
    const pending = await getPass(kit.env.DB, passId);
    if (!pending) throw new Error('Missing pending pass');
    expect(pending).toMatchObject({
      ownerUserId: null,
      credentialGeneration: initial.credentialGeneration + 1,
      linkGeneration: initial.linkGeneration + 1,
      version: initial.version,
    });
    expect(await getPassByDownloadToken(kit.env.DB, initial.downloadToken)).toBeNull();
    expect(
      await first(
        kit.env.DB,
        `SELECT state, target_holder_email, target_owner_user_id
      FROM pass_credential_transfers WHERE id = ?`,
        [transferId],
      ),
    ).toEqual({ state: 'pending', target_holder_email: email, target_owner_user_id: user.id });
    expect(
      await all(kit.env.DB, "SELECT id FROM outbox WHERE kind = 'email' AND pass_id = ?", [passId]),
    ).toEqual([]);
    expect(kit.mailer.sent).toHaveLength(sent);
    const pendingReplay = await issue(own.operator.session.headers, data, key);
    expect(pendingReplay.status).toBe(409);
    expect(await pendingReplay.json()).toMatchObject({ code: 'PASS_TRANSFER_PENDING' });

    // A pending transfer may publish under a newer reviewed release; delivery must follow
    // the completed artifact rather than binding the original, obsolete issuance snapshot.
    const newerRelease = await publish(own, template, 'live', release.generation);
    expect(await finishCredentialTransfer(jobCtxOf(kit), transferId)).toMatchObject({
      state: 'completed',
    });
    const replay = await issue(own.operator.session.headers, data, key);
    expect(replay.status, await replay.clone().text()).toBe(201);
    expect(await replay.json()).toMatchObject({
      id: passId,
      ownerUserId: user.id,
      holderState: 'owned',
    });
    const completed = await getPass(kit.env.DB, passId);
    if (!completed) throw new Error('Missing completed pass');
    expect(completed).toMatchObject({
      ownerUserId: user.id,
      holderEmail: email,
      credentialGeneration: pending.credentialGeneration,
      linkGeneration: pending.linkGeneration,
      version: initial.version + 1,
      releaseId: newerRelease.id,
    });
    expect(completed.serial).not.toBe(initial.serial);
    expect(completed.authToken).not.toBe(initial.authToken);
    expect(completed.scanCode).not.toBe(initial.scanCode);
    expect(completed.downloadToken).not.toBe(initial.downloadToken);
    expect(completed.objectKey).not.toBe(initial.objectKey);
    const artifact = await kit.env.BUCKET.get(completed.objectKey);
    if (!artifact) throw new Error('Missing completed artifact');
    const files = unzipSync(new Uint8Array(await artifact.arrayBuffer()));
    expect(JSON.parse(new TextDecoder().decode(files['pass.json']))).toMatchObject({
      serialNumber: completed.serial,
      authenticationToken: completed.authToken,
    });
    const outboxes = await all<{ id: string }>(
      kit.env.DB,
      "SELECT id FROM outbox WHERE kind = 'email' AND pass_id = ?",
      [passId],
    );
    expect(outboxes).toHaveLength(1);
    if (!outboxes[0]) throw new Error('Deferred issuance email was lost');
    const duplicate = await issue(own.operator.session.headers, data, key);
    expect(duplicate.status).toBe(201);
    expect(
      await all(kit.env.DB, "SELECT id FROM outbox WHERE kind = 'email' AND pass_id = ?", [passId]),
    ).toHaveLength(1);
    await handleEmailSend({ kind: 'email.send', outboxId: outboxes[0].id }, jobCtxOf(kit));
    expect(kit.mailer.sent).toHaveLength(sent + 1);
    expect(kit.mailer.sent.at(-1)).toMatchObject({ to: email });
    expect(kit.mailer.sent.at(-1)?.html).toContain(completed.downloadToken);
    expect(kit.mailer.sent.at(-1)?.html).not.toContain(initial.downloadToken);
  }, 60_000);

  it('reports an unknown email outcome on replay rather than sending twice', async () => {
    const { release } = await approved();
    const email = `unknown-${unique()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, 'x')}@example.com`;
    const key = unique();
    const data = { ...body(own, release), holderEmail: email, sendEmail: true };
    const response = await issue(own.operator.session.headers, data, key);
    expect(response.status, await response.clone().text()).toBe(201);
    const { id } = (await response.json()) as { id: string };
    const rows = await all<{ id: string }>(
      kit.env.DB,
      "SELECT id FROM outbox WHERE kind = 'email' AND pass_id = ?",
      [id],
    );
    expect(rows).toHaveLength(1);
    if (!rows[0]) throw new Error('Missing issuance email');
    const outboxId = rows[0].id;
    const send = kit.mailer.send.bind(kit.mailer);
    const spy = vi.spyOn(kit.mailer, 'send').mockImplementationOnce(async (message) => {
      await send(message);
      throw new Error('connection lost after acceptance');
    });
    const sent = kit.mailer.sent.length;
    try {
      await handleEmailSend({ kind: 'email.send', outboxId }, jobCtxOf(kit));
    } finally {
      spy.mockRestore();
    }
    expect(kit.mailer.sent).toHaveLength(sent + 1);
    expect(
      await first(kit.env.DB, 'SELECT state, error_code FROM outbox WHERE id = ?', [outboxId]),
    ).toEqual({ state: 'partial', error_code: 'EMAIL_OUTCOME_UNKNOWN' });
    const replay = await issue(own.operator.session.headers, data, key);
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ code: 'EMAIL_OUTCOME_UNKNOWN' });
    expect(
      await all(kit.env.DB, "SELECT id FROM outbox WHERE kind = 'email' AND pass_id = ?", [id]),
    ).toHaveLength(1);
    expect(kit.mailer.sent).toHaveLength(sent + 1);
  }, 60_000);

  it('retains an issuance email across a temporary recipient rate cap', async () => {
    const { release } = await approved();
    const email = `limited-${unique()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, 'x')}@example.com`;
    const recipient = (await sha256Hex(`pass-email:${email}`)).slice(0, 32);
    const counterKey = `pass-email:live:to:${recipient}`;
    const window = kit.clock.now() - (kit.clock.now() % 3_600_000);
    await run(kit.env.DB, 'INSERT INTO counters (key, window_start, count) VALUES (?, ?, ?)', [
      counterKey,
      window,
      EMAIL_RECIPIENT_HOURLY_CAP,
    ]);
    const key = unique();
    const data = { ...body(own, release), holderEmail: email, sendEmail: true };
    const sent = kit.mailer.sent.length;
    const response = await issue(own.operator.session.headers, data, key);
    expect(response.status, await response.clone().text()).toBe(201);
    const { id } = (await response.json()) as { id: string };
    const pass = await getPass(kit.env.DB, id);
    if (!pass) throw new Error('Missing issued pass');
    expect(
      await all(kit.env.DB, "SELECT id FROM outbox WHERE kind = 'email' AND pass_id = ?", [id]),
    ).toEqual([]);
    expect(
      await first(kit.env.DB, 'SELECT state FROM pass_issuance_deliveries WHERE pass_id = ?', [id]),
    ).toEqual({ state: 'pending' });
    expect(kit.mailer.sent).toHaveLength(sent);
    await run(kit.env.DB, 'DELETE FROM counters WHERE key = ? AND window_start = ?', [
      counterKey,
      window,
    ]);
    kit.clock.advance(60_000);
    await recoverIssuanceDeliveries(jobCtxOf(kit), id);
    const queued = await all<{ id: string }>(
      kit.env.DB,
      "SELECT id FROM outbox WHERE kind = 'email' AND pass_id = ?",
      [id],
    );
    expect(queued).toHaveLength(1);
    if (!queued[0]) throw new Error('Rate-limited issuance email was lost');
    const replay = await issue(own.operator.session.headers, data, key);
    expect(replay.status).toBe(201);
    expect(
      await all(kit.env.DB, "SELECT id FROM outbox WHERE kind = 'email' AND pass_id = ?", [id]),
    ).toHaveLength(1);
    await handleEmailSend({ kind: 'email.send', outboxId: queued[0].id }, jobCtxOf(kit));
    expect(kit.mailer.sent).toHaveLength(sent + 1);
    expect(kit.mailer.sent.at(-1)).toMatchObject({ to: email });
    expect(kit.mailer.sent.at(-1)?.html).toContain(pass.downloadToken);
  }, 60_000);

  it.each([
    [
      'lifecycle generation',
      'UPDATE passes SET lifecycle_generation = lifecycle_generation + 1 WHERE id = ?',
    ],
  ])(
    'does not send if the issued %s changes after insertion',
    async (_name, mutation) => {
      const { release } = await approved();
      const email = `race-${unique()
        .toLowerCase()
        .replace(/[^a-z0-9]/g, 'x')}@example.com`;
      await makeUser(kit.fx, { primaryEmail: email });
      const key = unique();
      let passId = '';
      const sent = kit.mailer.sent.length;
      const response = await atMutation(
        'outbox',
        async (db) => {
          const claim = await reservation(own.orgId, key, db);
          if (!claim) throw new Error('Expected an issuance reservation');
          passId = claim.resource_id;
          await run(db, mutation, [passId]);
        },
        () =>
          issue(
            own.operator.session.headers,
            {
              ...body(own, release),
              holderEmail: email,
              sendEmail: true,
            },
            key,
          ),
      );
      expect(response.status).toBe(409);
      expect(
        await all(kit.env.DB, 'SELECT id FROM pass_credential_transfers WHERE pass_id = ?', [
          passId,
        ]),
      ).toEqual([]);
      expect(
        await all(kit.env.DB, "SELECT id FROM outbox WHERE kind = 'email' AND pass_id = ?", [
          passId,
        ]),
      ).toEqual([]);
      expect(kit.mailer.sent).toHaveLength(sent);
    },
    60_000,
  );

  it.each([
    ['revision', 'UPDATE passes SET revision = revision + 1 WHERE id = ?'],
    ['issuance release', 'UPDATE passes SET release_id = NULL WHERE id = ?'],
    [
      'service URL',
      "UPDATE passes SET web_service_url = 'https://wrong.example/wallet' WHERE id = ?",
    ],
  ])(
    'still queues the mail when the issued %s changes after insertion (content, not authority: F12/F13)',
    async (_name, mutation) => {
      const { release } = await approved();
      const email = `race-${unique()
        .toLowerCase()
        .replace(/[^a-z0-9]/g, 'x')}@example.com`;
      await makeUser(kit.fx, { primaryEmail: email });
      const key = unique();
      let passId = '';
      const sent = kit.mailer.sent.length;
      const response = await atMutation(
        'outbox',
        async (db) => {
          const claim = await reservation(own.orgId, key, db);
          if (!claim) throw new Error('Expected an issuance reservation');
          passId = claim.resource_id;
          await run(db, mutation, [passId]);
        },
        () =>
          issue(
            own.operator.session.headers,
            {
              ...body(own, release),
              holderEmail: email,
              sendEmail: true,
            },
            key,
          ),
      );
      expect(response.status).toBe(201);
      expect(
        await all(kit.env.DB, "SELECT id FROM outbox WHERE kind = 'email' AND pass_id = ?", [
          passId,
        ]),
      ).toHaveLength(1);
      expect(kit.mailer.sent).toHaveLength(sent);
    },
    60_000,
  );

  it('does not deliver an initial issuance after its link changes at the outbox CAS', async () => {
    const { release } = await approved();
    const email = `race-${unique()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, 'x')}@example.com`;
    await makeUser(kit.fx, { primaryEmail: email });
    const key = unique();
    let passId = '';
    const sent = kit.mailer.sent.length;
    const response = await atMutation(
      'outbox',
      async (db) => {
        const claim = await reservation(own.orgId, key, db);
        if (!claim) throw new Error('Expected an issuance reservation');
        passId = claim.resource_id;
        await run(
          db,
          'UPDATE passes SET download_token = ?, link_generation = link_generation + 1 WHERE id = ?',
          [kit.fx.ids.token(), passId],
        );
      },
      () =>
        issue(
          own.operator.session.headers,
          {
            ...body(own, release),
            holderEmail: email,
            sendEmail: true,
          },
          key,
        ),
    );
    expect(response.status).toBe(409);
    expect(
      await all(kit.env.DB, 'SELECT id FROM pass_credential_transfers WHERE pass_id = ?', [passId]),
    ).toEqual([]);
    expect(
      await all(kit.env.DB, "SELECT id FROM outbox WHERE kind = 'email' AND pass_id = ?", [passId]),
    ).toEqual([]);
    expect(kit.mailer.sent).toHaveLength(sent);
  }, 60_000);

  it('issues with the approved Test release in the reviewed Test mode', async () => {
    const { template, release: live } = await approved();
    const test = await publish(own, template, 'test');
    expect(test.id).not.toBe(live.id);
    const response = await issue(
      { ...own.operator.session.headers, 'x-passbook-mode': 'test' },
      body(own, test),
      unique(),
    );
    expect(response.status, await response.clone().text()).toBe(201);
    await assertIssued(((await response.json()) as { id: string }).id, own, test);
    const testKey = await makeTenantTestApiKey(kit.fx, {
      orgId: own.orgId,
      scopes: ['passes:write'],
      mode: 'test',
    });
    const rejectedKey = unique();
    const liveBody = body(own, live);
    const before = await objects();
    expect(
      (await issue({ ...testKey.headers, 'x-passbook-mode': 'live' }, liveBody, rejectedKey))
        .status,
    ).toBe(409);
    await assertNoIssue(own, liveBody.externalId, rejectedKey, before);
    const fromKey = await issue(
      { ...testKey.headers, 'x-passbook-mode': 'live' },
      body(own, test),
      unique(),
    );
    expect(fromKey.status, await fromKey.clone().text()).toBe(201);
    await assertIssued(((await fromKey.json()) as { id: string }).id, own, test);
  }, 60_000);

  it('requires the release identity and positive generation, not just the active version', async () => {
    const { release } = await approved();
    const base = body(own, release);
    for (const patch of [
      { releaseId: undefined },
      { releaseId: null },
      { releaseGeneration: undefined },
      { releaseGeneration: null },
      { releaseGeneration: 0 },
      { releaseGeneration: -1 },
      { releaseGeneration: 1.5 },
      { mode: undefined },
      { templateVersion: undefined },
    ]) {
      const key = unique();
      const data = { ...base, ...patch, externalId: unique() };
      const before = await objects();
      expect((await issue(own.operator.session.headers, data, key)).status).toBe(422);
      await assertNoIssue(own, data.externalId, key, before);
    }
  }, 60_000);

  it('rejects foreign, different-template, different-mode, version and generation release selections', async () => {
    const { template, release } = await approved();
    const otherTemplate = await approved();
    const otherTenant = await approved(foreign);
    const testRelease = await publish(own, template, 'test');
    const draft = await imported(own, template.name, 2);
    expect(draft.templateId).toBe(template.templateId);
    expect(draft.version).not.toBe(template.version);
    const selections = [
      { releaseId: kit.fx.ids.id() },
      { releaseId: otherTenant.release.id, releaseGeneration: otherTenant.release.generation },
      { releaseId: otherTemplate.release.id, releaseGeneration: otherTemplate.release.generation },
      { releaseId: testRelease.id, releaseGeneration: testRelease.generation },
      { templateVersion: draft.version },
      { releaseGeneration: release.generation + 1 },
    ];
    for (const selection of selections) {
      const key = unique();
      const data = { ...body(own, release), ...selection };
      const before = await objects();
      const response = await issue(own.operator.session.headers, data, key);
      expect([403, 404, 409, 412]).toContain(response.status);
      await assertNoIssue(own, data.externalId, key, before);
    }
    // Even a new active draft does not displace the exact reviewed release version.
    const response = await issue(own.operator.session.headers, body(own, release), unique());
    expect(response.status, await response.clone().text()).toBe(201);
    await assertIssued(((await response.json()) as { id: string }).id, own, release);
  }, 60_000);

  it('does not use another organization’s release for the same reassigned template and version', async () => {
    const { template, release } = await approved(foreign);
    expect(
      await activeRelease(jobCtxOf(kit), template.templateId, foreign.orgId, 'live', 'apple'),
    ).toMatchObject({ id: release.id, orgId: foreign.orgId, version: template.version });
    await run(kit.env.DB, 'UPDATE templates SET org_id = ? WHERE id = ?', [
      own.orgId,
      template.templateId,
    ]);
    expect(
      await first(kit.env.DB, 'SELECT org_id FROM templates WHERE id = ?', [template.templateId]),
    ).toEqual({ org_id: own.orgId });
    const key = unique();
    const data = { ...body(foreign, release), orgId: own.orgId };
    const before = await objects();
    const response = await issue(own.operator.session.headers, data, key);
    expect([403, 404, 409, 412]).toContain(response.status);
    await assertNoIssue(own, data.externalId, key, before);
  }, 60_000);

  it('cannot approve a non-Apple provider or issue with an invented release id', async () => {
    const template = await imported(own);
    const response = await templatePost(
      `/${encodeURIComponent(template.templateId)}/candidates`,
      own.author,
      'live',
      {
        orgId: own.orgId,
        mode: 'live',
        provider: 'google',
        version: template.version,
      },
    );
    expect(response.status).toBe(422);
    const key = unique();
    const externalId = unique();
    const before = await objects();
    const rejected = await issue(
      own.operator.session.headers,
      {
        orgId: own.orgId,
        mode: 'live',
        templateId: template.templateId,
        templateVersion: template.version,
        releaseId: kit.fx.ids.id(),
        releaseGeneration: 1,
        input: { memberName: 'Unapproved' },
        externalId,
      },
      key,
    );
    expect([403, 404, 409, 412]).toContain(rejected.status);
    await assertNoIssue(own, externalId, key, before);
  }, 60_000);

  it('replays a committed review after supersession without weakening idempotency or tenant authority', async () => {
    const { template, release: original } = await approved();
    const operator = await member(own.orgId, ['pass_operator']);
    const key = unique();
    const data = body(own, original);
    const issued = await issue(operator.session.headers, data, key);
    expect(issued.status).toBe(201);
    const { id } = (await issued.json()) as { id: string };
    await assertIssued(id, own, original);
    const beforeReplay = await objects();
    const originalReservation = await reservation(own.orgId, key);
    expect(originalReservation).not.toBeNull();
    for (const changed of [
      { releaseId: kit.fx.ids.id() },
      { releaseGeneration: original.generation + 1 },
    ]) {
      const response = await issue(operator.session.headers, { ...data, ...changed }, key);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    }
    const versions = await all(
      kit.env.DB,
      'SELECT * FROM pass_versions WHERE pass_id = ? ORDER BY version',
      [id],
    );
    const events = await all(
      kit.env.DB,
      'SELECT * FROM pass_events WHERE pass_id = ? ORDER BY id',
      [id],
    );
    const audit = await all(
      kit.env.DB,
      "SELECT * FROM audit_log WHERE target_type = 'pass' AND target_id = ? ORDER BY id",
      [id],
    );
    const latest = await publish(own, template, 'live', original.generation);
    expect(
      await activeRelease(jobCtxOf(kit), template.templateId, own.orgId, 'live', 'apple'),
    ).toMatchObject({
      id: latest.id,
      generation: original.generation + 1,
      version: original.version,
    });
    const replay = await issue(operator.session.headers, data, key);
    expect(replay.status, await replay.clone().text()).toBe(201);
    expect(await replay.json()).toMatchObject({ id });
    expect(await reservation(own.orgId, key)).toEqual(originalReservation);
    expect(
      await all(kit.env.DB, 'SELECT id FROM passes WHERE org_id = ? AND external_id = ?', [
        own.orgId,
        data.externalId,
      ]),
    ).toEqual([{ id }]);
    expect(await objects()).toEqual(beforeReplay);
    expect(
      await all(kit.env.DB, 'SELECT * FROM pass_versions WHERE pass_id = ? ORDER BY version', [id]),
    ).toEqual(versions);
    expect(
      await all(kit.env.DB, 'SELECT * FROM pass_events WHERE pass_id = ? ORDER BY id', [id]),
    ).toEqual(events);
    expect(
      await all(
        kit.env.DB,
        "SELECT * FROM audit_log WHERE target_type = 'pass' AND target_id = ? ORDER BY id",
        [id],
      ),
    ).toEqual(audit);
    await assertIssued(id, own, original);
    await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
      kit.clock.now(),
      operator.membershipId,
    ]);
    expect((await issue(operator.session.headers, data, key)).status).toBe(403);
    expect(await reservation(own.orgId, key)).toEqual(originalReservation);
    expect(await objects()).toEqual(beforeReplay);
    const different = await issue(
      own.operator.session.headers,
      {
        ...data,
        releaseId: latest.id,
        releaseGeneration: latest.generation,
      },
      key,
    );
    expect(different.status).toBe(409);
    expect(await different.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    const staleKey = unique();
    const stale = { ...data, externalId: unique() };
    const before = await objects();
    const rejected = await issue(own.operator.session.headers, stale, staleKey);
    expect([409, 412]).toContain(rejected.status);
    await assertNoIssue(own, stale.externalId, staleKey, before);
  }, 60_000);
});

describe('issuance commit fences', () => {
  it('fences a newer release published after upload but immediately before the D1 insert', async () => {
    const { template, release } = await approved();
    const holderEmail = `holder-race-${unique()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, 'x')}@example.com`;
    const holder = await makeUser(kit.fx, { primaryEmail: holderEmail });
    const key = unique();
    const data = { ...body(own, release), holderEmail, sendEmail: true };
    const before = await objects();
    const emails = kit.mailer.sent.length;
    let passId = '';
    let latest: Release | null = null;
    const response = await atMutation(
      'passes',
      async (db) => {
        const claimed = await reservation(own.orgId, key, db);
        if (!claimed) throw new Error('Expected an idempotency reservation');
        passId = claimed.resource_id;
        expect(await pendingPassId(before)).toBe(passId);
        latest = await publish(own, template, 'live', release.generation);
      },
      () => issue(own.operator.session.headers, data, key),
    );
    expect([403, 409, 412]).toContain(response.status);
    await assertNoPass(passId);
    expect(
      await first(kit.env.DB, 'SELECT pass_id FROM pass_issuance_deliveries WHERE pass_id = ?', [
        passId,
      ]),
    ).toBeNull();
    await assertNoIssue(own, data.externalId, key, before);
    expect(kit.mailer.sent).toHaveLength(emails);
    if (!latest) throw new Error('New release was not published');
    const current = latest as Release;
    const retry = await issue(
      own.operator.session.headers,
      {
        ...data,
        releaseId: current.id,
        releaseGeneration: current.generation,
      },
      key,
    );
    expect(retry.status, await retry.clone().text()).toBe(201);
    const issued = (await retry.json()) as { id: string; ownerUserId: string | null };
    expect(issued.ownerUserId).toBe(holder.id);
    await assertIssued(issued.id, own, current);
  }, 60_000);

  it.each(['membership', 'session', 'API key', 'release'] as const)(
    'cleans up when the %s changes during the build',
    async (kind) => {
      const { template, release } = await approved();
      const operator = kind === 'API key' ? null : await member(own.orgId, ['pass_operator']);
      const apiKey =
        kind === 'API key'
          ? await makeApiKey(kit.fx, { orgId: own.orgId, scopes: ['passes:write'] })
          : null;
      const headers = operator?.session.headers ?? apiKey?.headers;
      if (!headers) throw new Error('Credential missing');
      const key = unique();
      const data = {
        ...body(own, release),
        holderEmail: `${unique()}@example.com`,
        sendEmail: true,
      };
      const before = await objects();
      const emails = kit.mailer.sent.length;
      let passId = '';
      let latest: Release | null = null;
      const response = await duringBuild(
        async () => {
          const claimed = await reservation(own.orgId, key);
          if (!claimed) throw new Error('Expected an idempotency reservation during build');
          passId = claimed.resource_id;
          if (kind === 'membership' && operator)
            await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
              kit.clock.now(),
              operator.membershipId,
            ]);
          else if (kind === 'session' && operator)
            await run(kit.env.DB, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
              kit.clock.now(),
              await sha256Hex(operator.session.cookieValue),
            ]);
          else if (apiKey)
            await run(kit.env.DB, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
              kit.clock.now(),
              apiKey.id,
            ]);
          else latest = await publish(own, template, 'live', release.generation);
        },
        () => issue(headers, data, key),
      );
      expect([403, 409, 412]).toContain(response.status);
      await assertNoPass(passId);
      await assertNoIssue(own, data.externalId, key, before);
      expect(kit.mailer.sent).toHaveLength(emails);
      const selected = latest ? (latest as Release) : release;
      const retry = await issue(
        own.operator.session.headers,
        {
          ...data,
          releaseId: selected.id,
          releaseGeneration: selected.generation,
        },
        key,
      );
      expect(retry.status, await retry.clone().text()).toBe(201);
      await assertIssued(((await retry.json()) as { id: string }).id, own, selected);
    },
    60_000,
  );

  it.each(['membership', 'API key', 'release'] as const)(
    'keeps a committed issuance when %s changes and sends only with continuing caller authority',
    async (kind) => {
      const { template, release } = await approved();
      const operator = await member(own.orgId, ['pass_operator']);
      const apiKey =
        kind === 'API key'
          ? await makeApiKey(kit.fx, { orgId: own.orgId, scopes: ['passes:write'] })
          : null;
      const key = unique();
      const data = {
        ...body(own, release),
        holderEmail: `${unique()}@example.com`,
        sendEmail: true,
      };
      const emails = kit.mailer.sent.length;
      let passId = '';
      const response = await atMutation(
        'outbox',
        async (db) => {
          const claimed = await reservation(own.orgId, key, db);
          if (!claimed) throw new Error('Expected the committed reservation');
          passId = claimed.resource_id;
          expect(await first(db, 'SELECT release_id FROM passes WHERE id = ?', [passId])).toEqual({
            release_id: release.id,
          });
          if (kind === 'membership')
            await run(db, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
              kit.clock.now(),
              operator.membershipId,
            ]);
          else if (apiKey)
            await run(db, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
              kit.clock.now(),
              apiKey.id,
            ]);
          else await publish(own, template, 'live', release.generation);
        },
        () => issue(apiKey?.headers ?? operator.session.headers, data, key),
      );
      await assertIssued(passId, own, release);
      expect(await reservation(own.orgId, key)).toMatchObject({ resource_id: passId });
      const outbox = await all(
        kit.env.DB,
        "SELECT id FROM outbox WHERE kind = 'email' AND pass_id = ?",
        [passId],
      );
      if (kind === 'release') {
        expect(response.status, await response.clone().text()).toBe(201);
        expect(await response.json()).toMatchObject({ id: passId });
        expect(outbox).toHaveLength(1);
        expect(
          await first(
            kit.env.DB,
            "SELECT id FROM pass_events WHERE kind = 'email.queued' AND pass_id = ?",
            [passId],
          ),
        ).not.toBeNull();
      } else {
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: 'DELIVERY_STALE' });
        expect(outbox).toEqual([]);
        expect(kit.mailer.sent).toHaveLength(emails);
      }
    },
    60_000,
  );

  it.each(['membership', 'API key'] as const)(
    'does not enqueue after %s authority is lost at the outbox insert',
    async (kind) => {
      const { release } = await approved();
      const operator = await member(own.orgId, ['pass_operator']);
      const apiKey =
        kind === 'API key'
          ? await makeApiKey(kit.fx, { orgId: own.orgId, scopes: ['passes:write'] })
          : null;
      const key = unique();
      const data = {
        ...body(own, release),
        holderEmail: `${unique()}@example.com`,
        sendEmail: true,
      };
      const orgKey = `pass-email:live:org:${own.orgId}`;
      const orgWindow = kit.clock.now() - (kit.clock.now() % 86_400_000);
      const orgCounter = await first(
        kit.env.DB,
        'SELECT count FROM counters WHERE key = ? AND window_start = ?',
        [orgKey, orgWindow],
      );
      const emails = kit.mailer.sent.length;
      let passId = '';
      const response = await atMutation(
        'outbox',
        async (db) => {
          const claimed = await reservation(own.orgId, key, db);
          if (!claimed) throw new Error('Expected the committed reservation');
          passId = claimed.resource_id;
          expect(await first(db, 'SELECT release_id FROM passes WHERE id = ?', [passId])).toEqual({
            release_id: release.id,
          });
          if (apiKey)
            await run(db, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
              kit.clock.now(),
              apiKey.id,
            ]);
          else
            await run(db, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
              kit.clock.now(),
              operator.membershipId,
            ]);
        },
        () => issue(apiKey?.headers ?? operator.session.headers, data, key),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'DELIVERY_STALE' });
      await assertIssued(passId, own, release);
      expect(await reservation(own.orgId, key)).toMatchObject({ resource_id: passId });
      expect(await all(kit.env.DB, 'SELECT id FROM outbox WHERE pass_id = ?', [passId])).toEqual(
        [],
      );
      const recipient = (await sha256Hex(`pass-email:${data.holderEmail.toLowerCase()}`)).slice(
        0,
        32,
      );
      expect(
        await first(kit.env.DB, 'SELECT count FROM counters WHERE key = ?', [
          `pass-email:live:to:${recipient}`,
        ]),
      ).toBeNull();
      expect(
        await first(kit.env.DB, 'SELECT count FROM counters WHERE key = ? AND window_start = ?', [
          orgKey,
          orgWindow,
        ]),
      ).toEqual(orgCounter);
      expect(kit.mailer.sent).toHaveLength(emails);
    },
    60_000,
  );

  it('binds the provider and candidate hash again at the D1 commit boundary', async () => {
    const { release } = await approved();
    const auth = await createSessionStore(kit.env, kit.clock).resolve(
      own.operator.session.cookieValue,
    );
    if (!auth) throw new Error('Real operator session did not resolve');
    const authority = await tenantAuthorityOf(jobCtxOf(kit), auth, own.orgId, 'passes:operate');
    const snapshot = {
      id: release.id,
      generation: release.generation,
      orgId: release.orgId,
      candidateHash: release.candidateHash,
      provider: 'apple' as const,
    };
    expect(await tenantPassAuthorityValid(kit.env.DB, authority, kit.clock.now())).toBe(true);
    const valid = approvedReleaseFence(
      snapshot,
      release.templateId,
      own.orgId,
      'live',
      release.version,
    );
    expect(await first(kit.env.DB, `SELECT 1 AS ok WHERE ${valid.sql}`, valid.params)).toEqual({
      ok: 1,
    });
    for (const forged of [
      {
        ...snapshot,
        candidateHash: (snapshot.candidateHash === 'f'.repeat(64) ? 'e' : 'f').repeat(64),
      },
      { ...snapshot, provider: 'google' as 'apple' },
      { ...snapshot, orgId: foreign.orgId },
      { ...snapshot, orgId: null },
      { ...snapshot, generation: snapshot.generation + 1 },
    ]) {
      const id = kit.fx.ids.id();
      const row: NewPassRow = {
        id,
        orgId: own.orgId,
        identityId: PLATFORM_IDENTITY_ID,
        serial: unique(),
        templateId: release.templateId,
        templateVersion: release.version,
        release: forged,
        authToken: unique(),
        downloadToken: unique(),
        webServiceUrl: `${ORIGIN}/wallet`,
        personalization: { memberName: 'Forged' },
        fieldSources: { memberName: 'manual' },
        displayTitle: 'Forged',
        displaySubtitle: null,
        externalId: unique(),
        holderEmail: null,
        connectionId: null,
        connectionGeneration: null,
        externalRef: null,
        objectKey: `passes/${id}/never-uploaded.pkpass`,
        objectSha256: 'a'.repeat(64),
        objectSize: 1,
        contentHash: 'b'.repeat(64),
        now: kit.clock.now(),
        createdBy: own.operator.user.id,
        passJson: '{}',
        actorType: 'user',
        actorId: own.operator.user.id,
        source: 'manual',
        credentialKeysetCommitment,
        credentialRefs: [],
        mode: 'live',
        scanCode: unique(),
        barcodeHash: null,
        lookupHash: null,
        execution: { kind: 'tenant', authority },
      };
      expect(await insertPass(jobCtxOf(kit), row)).toBe(false);
      await assertNoPass(id);
    }
  }, 60_000);

  it('rejects missing or mismatched execution at the atomic insertion boundary', async () => {
    const { release } = await approved();
    const operator = await member(own.orgId, ['pass_operator']);
    const secondOperator = await member(own.orgId, ['pass_operator']);
    const session = await createSessionStore(kit.env, kit.clock).resolve(
      operator.session.cookieValue,
    );
    const secondSession = await createSessionStore(kit.env, kit.clock).resolve(
      secondOperator.session.cookieValue,
    );
    const foreignSession = await createSessionStore(kit.env, kit.clock).resolve(
      foreign.operator.session.cookieValue,
    );
    if (!session || !secondSession || !foreignSession)
      throw new Error('Real operator sessions did not resolve');
    const authority = await tenantAuthorityOf(jobCtxOf(kit), session, own.orgId, 'passes:operate');
    const secondAuthority = await tenantAuthorityOf(
      jobCtxOf(kit),
      secondSession,
      own.orgId,
      'passes:operate',
    );
    const foreignAuthority = await tenantAuthorityOf(
      jobCtxOf(kit),
      foreignSession,
      foreign.orgId,
      'passes:operate',
    );
    const readAuthority = await tenantAuthorityOf(jobCtxOf(kit), session, own.orgId, 'passes:read');
    const testKey = await makeTenantTestApiKey(kit.fx, {
      orgId: own.orgId,
      scopes: ['passes:write'],
      mode: 'test',
    });
    const testAuthority = await keyAuthority(testKey, own.orgId);
    const connectionId = await connection(own);
    const otherConnection = await connection(own);
    const snapshot = {
      id: release.id,
      generation: release.generation,
      orgId: release.orgId,
      candidateHash: release.candidateHash,
      provider: 'apple' as const,
    };
    for (const captured of [
      authority,
      secondAuthority,
      foreignAuthority,
      readAuthority,
      testAuthority,
    ])
      expect(await tenantPassAuthorityValid(kit.env.DB, captured, kit.clock.now())).toBe(true);
    const fence = approvedReleaseFence(
      snapshot,
      release.templateId,
      own.orgId,
      'live',
      release.version,
    );
    expect(await first(kit.env.DB, `SELECT 1 AS ok WHERE ${fence.sql}`, fence.params)).toEqual({
      ok: 1,
    });
    const attempts: Partial<NewPassRow>[] = [
      { execution: undefined },
      { actorType: 'system', actorId: null, createdBy: null, execution: undefined },
      { execution: { kind: 'unknown' } as unknown as NewPassRow['execution'] },
      { execution: { kind: 'tenant' } as NewPassRow['execution'] },
      { execution: { kind: 'tenant', authority: foreignAuthority } },
      { execution: { kind: 'tenant', authority: readAuthority } },
      { execution: { kind: 'tenant', authority: testAuthority } },
      { execution: { kind: 'tenant', authority, additionalAuthority: secondAuthority } },
      {
        source: 'connection',
        connectionId: otherConnection,
        connectionGeneration: 1,
        externalRef: unique(),
        execution: { kind: 'connection', connectionId, generation: 1 },
      },
      {
        source: 'connection',
        connectionId,
        connectionGeneration: 1,
        externalRef: unique(),
        execution: { kind: 'connection', connectionId, generation: 2 },
      },
      {
        source: 'manual',
        connectionId,
        connectionGeneration: 1,
        externalRef: unique(),
        execution: { kind: 'connection', connectionId, generation: 1 },
      },
    ];
    for (const attempt of attempts) {
      const id = kit.fx.ids.id();
      const row: NewPassRow = {
        id,
        orgId: own.orgId,
        identityId: PLATFORM_IDENTITY_ID,
        serial: unique(),
        templateId: release.templateId,
        templateVersion: release.version,
        release: snapshot,
        authToken: unique(),
        downloadToken: unique(),
        webServiceUrl: `${ORIGIN}/wallet`,
        personalization: { memberName: 'Forged execution' },
        fieldSources: { memberName: 'manual' },
        displayTitle: 'Forged execution',
        displaySubtitle: null,
        externalId: unique(),
        holderEmail: null,
        connectionId: null,
        connectionGeneration: null,
        externalRef: null,
        source: 'manual',
        objectKey: `passes/${id}/never-uploaded.pkpass`,
        objectSha256: 'a'.repeat(64),
        objectSize: 1,
        contentHash: 'b'.repeat(64),
        now: kit.clock.now(),
        createdBy: operator.user.id,
        passJson: '{}',
        actorType: 'user',
        actorId: operator.user.id,
        credentialKeysetCommitment,
        credentialRefs: [],
        mode: 'live',
        scanCode: unique(),
        barcodeHash: null,
        lookupHash: null,
        execution: { kind: 'tenant', authority },
        ...attempt,
      };
      expect(await insertPass(jobCtxOf(kit), row)).toBe(false);
      await assertNoPass(id);
    }
  }, 60_000);
});

describe('direct issuance execution authority', () => {
  it('requires real scoped tenant authority regardless of audit attribution', async () => {
    const { release } = await approved();
    const operator = await member(own.orgId, ['pass_operator']);
    const secondOperator = await member(own.orgId, ['pass_operator']);
    const session = await createSessionStore(kit.env, kit.clock).resolve(
      operator.session.cookieValue,
    );
    const secondSession = await createSessionStore(kit.env, kit.clock).resolve(
      secondOperator.session.cookieValue,
    );
    const foreignSession = await createSessionStore(kit.env, kit.clock).resolve(
      foreign.operator.session.cookieValue,
    );
    if (!session || !secondSession || !foreignSession)
      throw new Error('Real operator sessions did not resolve');
    const authority = await tenantAuthorityOf(jobCtxOf(kit), session, own.orgId, 'passes:operate');
    const secondAuthority = await tenantAuthorityOf(
      jobCtxOf(kit),
      secondSession,
      own.orgId,
      'passes:operate',
    );
    const readAuthority = await tenantAuthorityOf(jobCtxOf(kit), session, own.orgId, 'passes:read');
    const foreignAuthority = await tenantAuthorityOf(
      jobCtxOf(kit),
      foreignSession,
      foreign.orgId,
      'passes:operate',
    );
    const key = await makeApiKey(kit.fx, { orgId: own.orgId, scopes: ['passes:write'] });
    const keySnapshot = await keyAuthority(key, own.orgId);
    const testKey = await makeTenantTestApiKey(kit.fx, {
      orgId: own.orgId,
      scopes: ['passes:write'],
      mode: 'test',
    });
    const testAuthority = await keyAuthority(testKey, own.orgId);
    const revokedKey = await makeApiKey(kit.fx, { orgId: own.orgId, scopes: ['passes:write'] });
    const revokedAuthority = await keyAuthority(revokedKey, own.orgId);
    await run(kit.env.DB, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
      kit.clock.now(),
      revokedKey.id,
    ]);
    for (const captured of [
      authority,
      secondAuthority,
      readAuthority,
      foreignAuthority,
      keySnapshot,
      testAuthority,
    ])
      expect(await tenantPassAuthorityValid(kit.env.DB, captured, kit.clock.now())).toBe(true);

    const base: CreateParams = {
      orgId: own.orgId,
      templateId: release.templateId,
      templateVersion: release.version,
      releaseId: release.id,
      releaseGeneration: release.generation,
      input: { memberName: 'Authority' },
      source: 'manual',
      mode: 'live',
      actor: { type: 'user', id: operator.user.id },
      execution: { kind: 'tenant', authority },
    };
    const attempts: { actor: CreateParams['actor']; execution: unknown }[] = [
      { actor: { type: 'user', id: operator.user.id }, execution: undefined },
      { actor: { type: 'api_key', id: key.id }, execution: undefined },
      { actor: { type: 'system', id: null }, execution: undefined },
      { actor: { type: 'system', id: null }, execution: { kind: 'unknown' } },
      { actor: { type: 'system', id: null }, execution: { kind: 'tenant' } },
      {
        actor: { type: 'system', id: null },
        execution: { kind: 'tenant', authority: readAuthority },
      },
      {
        actor: { type: 'system', id: null },
        execution: { kind: 'tenant', authority: foreignAuthority },
      },
      {
        actor: { type: 'system', id: null },
        execution: { kind: 'tenant', authority: testAuthority },
      },
      {
        actor: { type: 'system', id: null },
        execution: { kind: 'tenant', authority: revokedAuthority },
      },
      {
        actor: { type: 'system', id: null },
        execution: { kind: 'tenant', authority, additionalAuthority: secondAuthority },
      },
    ];
    for (const attempt of attempts) {
      const input = {
        ...base,
        ...attempt,
        passId: kit.fx.ids.id(),
        externalId: unique(),
      } as CreateParams;
      await expectEarlyDenied(input, 403, 'FORBIDDEN');
    }

    for (const correct of [
      {
        actor: { type: 'user' as const, id: operator.user.id },
        execution: { kind: 'tenant' as const, authority },
      },
      {
        actor: { type: 'api_key' as const, id: key.id },
        execution: { kind: 'tenant' as const, authority: keySnapshot },
      },
      {
        actor: { type: 'system' as const, id: null },
        execution: { kind: 'tenant' as const, authority },
      },
      {
        actor: { type: 'api_key' as const, id: key.id },
        execution: { kind: 'tenant' as const, authority },
      },
    ]) {
      const pass = await createPassRow(jobCtxOf(kit), {
        ...base,
        ...correct,
        passId: kit.fx.ids.id(),
        externalId: unique(),
      });
      await assertIssued(pass.id, own, release);
    }
  }, 60_000);

  it('requires the original connection execution, source and generation before any write', async () => {
    const { release } = await approved();
    const connectionId = await connection(own);
    const otherConnection = await connection(own);
    const base: CreateParams = {
      orgId: own.orgId,
      templateId: release.templateId,
      templateVersion: release.version,
      releaseId: release.id,
      releaseGeneration: release.generation,
      input: { memberName: 'Connection authority' },
      source: 'connection',
      mode: 'live',
      connectionId,
      connectionGeneration: 1,
      credentialKeysetCommitment,
      expectedConnectionMode: 'poll',
      externalRef: unique(),
      actor: { type: 'connection', id: connectionId },
      execution: { kind: 'connection', connectionId, generation: 1 },
    };
    const attempts: { patch: Partial<CreateParams>; status: number; code: string }[] = [
      { patch: { expectedConnectionMode: undefined }, status: 409, code: 'PASS_CONFLICT' },
      { patch: { credentialKeysetCommitment: undefined }, status: 409, code: 'PASS_CONFLICT' },
      { patch: { credentialKeysetCommitment: 'f'.repeat(64) }, status: 409, code: 'PASS_CONFLICT' },
      { patch: { connectionId: null }, status: 403, code: 'FORBIDDEN' },
      { patch: { source: 'manual' }, status: 403, code: 'FORBIDDEN' },
      { patch: { connectionGeneration: undefined }, status: 403, code: 'FORBIDDEN' },
      { patch: { connectionGeneration: 0 }, status: 403, code: 'FORBIDDEN' },
      {
        patch: { execution: { kind: 'connection', connectionId: otherConnection, generation: 1 } },
        status: 403,
        code: 'FORBIDDEN',
      },
      {
        patch: { execution: { kind: 'connection', connectionId, generation: 2 } },
        status: 403,
        code: 'FORBIDDEN',
      },
      {
        patch: {
          connectionGeneration: 2,
          execution: { kind: 'connection', connectionId, generation: 2 },
        },
        status: 409,
        code: 'PASS_CONFLICT',
      },
    ];
    for (const attempt of attempts)
      await expectEarlyDenied(
        {
          ...base,
          ...attempt.patch,
          passId: kit.fx.ids.id(),
          externalId: unique(),
          externalRef: unique(),
        },
        attempt.status,
        attempt.code,
      );

    for (const actor of [
      { type: 'connection' as const, id: connectionId },
      { type: 'system' as const, id: null },
    ]) {
      const pass = await createPassRow(jobCtxOf(kit), {
        ...base,
        actor,
        passId: kit.fx.ids.id(),
        externalId: unique(),
        externalRef: unique(),
      });
      await assertIssued(pass.id, own, release);
    }
  }, 60_000);
});

describe('trusted system issuance', () => {
  it('requires approval and the release version even with system authority', async () => {
    const unapproved = await imported(own);
    const passId = kit.fx.ids.id();
    const input: CreateParams = {
      passId,
      orgId: own.orgId,
      templateId: unapproved.templateId,
      templateVersion: unapproved.version,
      mode: 'live',
      input: { memberName: 'System' },
      source: 'manual',
      actor: { type: 'system', id: null },
      execution: { kind: 'system' },
    };
    await expect(createPassRow(jobCtxOf(kit), input)).rejects.toMatchObject({
      status: 409,
      code: 'TEMPLATE_RELEASE_REQUIRED',
    });
    await assertNoPass(passId);

    const { template, release } = await approved();
    const draft = await imported(own, template.name, 2);
    expect(draft.templateId).toBe(template.templateId);
    expect(draft.version).not.toBe(release.version);
    const reviewed: CreateParams = {
      ...input,
      passId: kit.fx.ids.id(),
      templateId: template.templateId,
      templateVersion: release.version,
    };
    await expect(
      createPassRow(jobCtxOf(kit), { ...reviewed, templateVersion: '' }),
    ).rejects.toMatchObject({ status: 422, code: 'VALIDATION' });
    await expect(
      createPassRow(jobCtxOf(kit), {
        ...reviewed,
        templateVersion: undefined,
      } as unknown as CreateParams),
    ).rejects.toMatchObject({ status: 422, code: 'VALIDATION' });
    await expect(
      createPassRow(jobCtxOf(kit), { ...reviewed, templateVersion: draft.version }),
    ).rejects.toMatchObject({ status: 409, code: 'TEMPLATE_RELEASE_CONFLICT' });
    await assertNoPass(reviewed.passId ?? '');
    const pass = await createPassRow(jobCtxOf(kit), reviewed);
    await assertIssued(pass.id, own, release);
  }, 60_000);
});

describe('global baked approval', () => {
  it('uses the same persisted system release for two organizations', async () => {
    const release = await activeRelease(
      jobCtxOf(kit),
      baked.template.id,
      own.orgId,
      'live',
      'apple',
    );
    const other = await activeRelease(
      jobCtxOf(kit),
      baked.template.id,
      foreign.orgId,
      'live',
      'apple',
    );
    expect(release).not.toBeNull();
    if (!release) throw new Error('Baked system release missing');
    expect(release).toMatchObject({
      orgId: null,
      mode: 'live',
      provider: 'apple',
      version: baked.template.version,
    });
    expect(release.candidateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(other).toEqual(release);
    for (const ws of [own, foreign]) {
      const response = await issue(ws.operator.session.headers, body(ws, release), unique());
      expect(response.status, await response.clone().text()).toBe(201);
      await assertIssued(((await response.json()) as { id: string }).id, ws, release);
    }
  }, 60_000);

  it('invalidates the global fallback when its baked template is reassigned at commit', async () => {
    const release = await activeRelease(
      jobCtxOf(kit),
      bakedRace.template.id,
      own.orgId,
      'live',
      'apple',
    );
    if (!release) throw new Error('Baked system release missing');
    const key = unique();
    const data = body(own, release);
    const before = await objects();
    let passId = '';
    const response = await atMutation(
      'passes',
      async (db) => {
        const claimed = await reservation(own.orgId, key, db);
        if (!claimed) throw new Error('Expected an idempotency reservation');
        passId = claimed.resource_id;
        expect(await pendingPassId(before)).toBe(passId);
        // Simulate a persisted reassignment immediately before the issuance transaction.
        await run(db, 'UPDATE templates SET org_id = ?, updated_at = updated_at + 1 WHERE id = ?', [
          own.orgId,
          bakedRace.template.id,
        ]);
        for (const ws of [own, foreign]) {
          const fence = approvedReleaseFence(
            {
              id: release.id,
              generation: release.generation,
              orgId: release.orgId,
              candidateHash: release.candidateHash,
              provider: 'apple',
            },
            release.templateId,
            ws.orgId,
            release.mode,
            release.version,
          );
          expect(await first(db, `SELECT 1 AS ok WHERE ${fence.sql}`, fence.params)).toBeNull();
        }
      },
      () => issue(own.operator.session.headers, data, key),
    );
    expect([403, 404, 409, 412]).toContain(response.status);
    await assertNoPass(passId);
    await assertNoIssue(own, data.externalId, key, before);
    expect(
      await first(kit.env.DB, 'SELECT org_id FROM templates WHERE id = ?', [bakedRace.template.id]),
    ).toEqual({ org_id: own.orgId });
    // Resolution may synchronize a new system release for the reassigned organization.
    const current = await activeRelease(
      jobCtxOf(kit),
      bakedRace.template.id,
      own.orgId,
      'live',
      'apple',
    );
    expect(current).not.toBeNull();
    if (!current) throw new Error('Reassigned baked system release missing');
    expect(current.id).not.toBe(release.id);
    expect(current).toMatchObject({
      orgId: own.orgId,
      templateId: release.templateId,
      mode: release.mode,
      version: release.version,
    });
    expect(
      await activeRelease(jobCtxOf(kit), bakedRace.template.id, foreign.orgId, 'live', 'apple'),
    ).toBeNull();
    for (const ws of [own, foreign]) {
      const rejectedKey = unique();
      const rejectedData = body(ws, release);
      const rejected = await issue(ws.operator.session.headers, rejectedData, rejectedKey);
      expect([403, 404, 409, 412]).toContain(rejected.status);
      await assertNoIssue(ws, rejectedData.externalId, rejectedKey, before);
    }
    const foreignKey = unique();
    const foreignData = body(foreign, current);
    const foreignResponse = await issue(foreign.operator.session.headers, foreignData, foreignKey);
    expect([403, 404, 409, 412]).toContain(foreignResponse.status);
    await assertNoIssue(foreign, foreignData.externalId, foreignKey, before);
    const issued = await issue(
      own.operator.session.headers,
      body(own, current, data.externalId),
      key,
    );
    const issuedDetail = await created<{ id: string }>(issued);
    await assertIssued(issuedDetail.id, own, current);
    expect(await reservation(own.orgId, key)).toMatchObject({ resource_id: issuedDetail.id });
  }, 60_000);
});

async function connection(ws: Workspace) {
  const id = kit.fx.ids.id();
  await run(
    kit.env.DB,
    `INSERT INTO connections (id, org_id, connector_type, name, generation, created_at, updated_at)
    VALUES (?, ?, 'demo', 'approved source', 1, ?, ?)`,
    [id, ws.orgId, kit.clock.now(), kit.clock.now()],
  );
  return id;
}

function connectionInput(ws: Workspace, release: Release, connectionId: string) {
  return {
    orgId: ws.orgId,
    mode: 'live' as const,
    templateId: release.templateId,
    expectedRelease: { id: release.id, generation: release.generation, version: release.version },
    connectionId,
    generation: 1,
    credentialKeysetCommitment,
    expectedConnectionMode: 'poll' as const,
    externalRef: unique(),
    fields: { memberName: 'Source member' },
    holderEmail: `${unique()}@example.com`,
    sendEmail: true,
  };
}

/** Stage an encrypted ingress and claim its reserved ID through the real item admission CAS. */
async function startedWebhookIssuance(release: Release) {
  const connectionId = await connection(own);
  await run(
    kit.env.DB,
    `UPDATE connections SET mode = 'webhook', auto_create = 1, default_template_id = ?
    WHERE id = ?`,
    [release.templateId, connectionId],
  );
  const connectionState = await first<{ generation: number }>(
    kit.env.DB,
    'SELECT generation FROM connections WHERE id = ?',
    [connectionId],
  );
  if (!connectionState) throw new Error('Missing connection');
  const externalRef = unique();
  const passId = kit.fx.ids.id();
  const retentionId = kit.fx.ids.id();
  const token = unique();
  const { refHash, credentialKeysetCommitment } = await retainedWebhookRefHash(
    jobCtxOf(kit),
    own.orgId,
    connectionId,
    externalRef,
  );
  const expectedRelease = {
    kind: 'approved' as const,
    id: release.id,
    generation: release.generation,
    version: release.version,
  };
  const now = kit.clock.now();
  const payload = {
    refs: [externalRef],
    items: [{ ref: externalRef, record: null, deleted: false }],
    rawBody: null,
    credentialKeysetCommitment,
  };
  const row: RetainedRow = {
    id: retentionId,
    orgId: own.orgId,
    connectionId,
    eventId: unique(),
    generation: connectionState.generation,
    source: 'ingress',
    connectionMode: 'webhook',
    referenceMode: 'embedded-required',
    refHash: await sha256Hex(JSON.stringify([externalRef])),
    state: 'pending',
    errorCode: null,
    releaseSnapshot: JSON.stringify(expectedRelease),
    snapshotKnown: true,
    revision: 0,
    itemCount: 1,
    chunkCount: 1,
    replayGeneration: 0,
    credentialKeysetCommitment,
    envelope: await encryptSecret(
      await loadKekRing(kit.env),
      JSON.stringify(payload),
      credentialAad(retentionId, own.orgId, 'connection.webhook'),
    ),
    receivedAt: now,
    updatedAt: now,
  };
  expect(await insertStagedWebhook(jobAt(kit.env.DB), [row])).toBe(true);
  const candidate = {
    kind: 'new' as const,
    reservedPassId: passId,
    orgId: own.orgId,
    connectionId,
    externalRef,
    generation: row.generation,
    templateId: release.templateId,
    expectedRelease,
    credentialKeysetCommitment,
  };
  const snapshot = claimSnapshot(row, candidate, refHash, credentialKeysetCommitment);
  expect(
    await startNewItem(
      jobAt(kit.env.DB),
      row,
      0,
      token,
      candidate,
      snapshot,
      refHash,
      credentialKeysetCommitment,
    ),
  ).toBe(true);
  const input: CreateParams = {
    orgId: own.orgId,
    templateId: release.templateId,
    templateVersion: release.version,
    releaseId: release.id,
    releaseGeneration: release.generation,
    input: { memberName: 'Retained item' },
    holderEmail: `claim-${unique()}@example.com`,
    sendEmail: true,
    mode: 'live',
    source: 'connection',
    connectionId,
    connectionGeneration: row.generation,
    credentialKeysetCommitment,
    expectedConnectionMode: 'webhook',
    externalRef,
    execution: { kind: 'connection', connectionId, generation: row.generation },
    actor: { type: 'connection', id: connectionId },
    reservedPassId: passId,
    retainedClaim: {
      retentionId,
      ordinal: 0,
      token,
      revision: row.revision,
      refHash,
      credentialKeysetCommitment,
    },
  };
  return { row, input, candidate, snapshot, token, passId, refHash, credentialKeysetCommitment };
}

describe('approved connection issuance', () => {
  it('pins the first connection strategy for manual bound issuance, including its retry', async () => {
    const { release } = await approved();
    const connectionId = await connection(own);
    const key = unique();
    const data = {
      ...body(own, release),
      connectionId,
      externalRef: unique(),
      holderEmail: `bound-${unique()
        .toLowerCase()
        .replace(/[^a-z0-9]/g, 'x')}@example.com`,
      sendEmail: true,
    };
    const before = await objects();
    let passId = '';
    const response = await atMutation(
      'passes',
      async (db) => {
        const claim = await reservation(own.orgId, key, db);
        if (!claim) throw new Error('Expected an issuance reservation');
        passId = claim.resource_id;
        await run(db, "UPDATE connections SET mode = 'webhook' WHERE id = ?", [connectionId]);
      },
      () => issue(own.operator.session.headers, data, key),
    );
    expect(response.status).toBe(409);
    await assertNoPass(passId);
    await assertNoIssue(own, data.externalId, key, before);

    const retry = await issue(own.operator.session.headers, data, key);
    expect(retry.status, await retry.clone().text()).toBe(201);
    const issued = (await retry.json()) as { id: string };
    await assertIssued(issued.id, own, release);
    expect(
      await all(kit.env.DB, "SELECT id FROM outbox WHERE kind = 'email' AND pass_id = ?", [
        issued.id,
      ]),
    ).toHaveLength(1);
  }, 60_000);

  it('issues exactly the pass ID reserved by a live retained webhook claim', async () => {
    const { release } = await approved();
    const claim = await startedWebhookIssuance(release);
    const pass = await createPassRow(jobCtxOf(kit), claim.input);
    expect(pass.id).toBe(claim.passId);
    await assertIssued(pass.id, own, release);
    expect(
      await all(kit.env.DB, "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'email'", [
        pass.id,
      ]),
    ).toHaveLength(1);
  }, 60_000);

  it('uses the original immutable webhook claim even if its caller mutates the input during signing', async () => {
    const { release } = await approved();
    const claim = await startedWebhookIssuance(release);
    const emailSuffix = unique().toLowerCase();
    claim.input.holderEmail = `Claim-${emailSuffix}@Example.COM`;
    const originalRef = claim.input.externalRef;
    const originalEmail = `claim-${emailSuffix}@example.com`;
    const pass = await duringBuild(
      async () => {
        claim.input.externalRef = 'changed-after-claim';
        claim.input.holderEmail = 'changed-after-claim@example.com';
        if (!claim.input.retainedClaim) throw new Error('Missing retained claim');
        claim.input.retainedClaim.token = unique();
        claim.input.retainedClaim.refHash = 'f'.repeat(64);
      },
      () => createPassRow(jobCtxOf(kit), claim.input),
    );
    expect(pass).toMatchObject({
      id: claim.passId,
      externalRef: originalRef,
      holderEmail: originalEmail,
    });
    expect(
      await first(kit.env.DB, 'SELECT external_ref, holder_email FROM passes WHERE id = ?', [
        claim.passId,
      ]),
    ).toEqual({ external_ref: originalRef, holder_email: originalEmail });
    expect(
      await first(kit.env.DB, 'SELECT recipient FROM pass_issuance_deliveries WHERE pass_id = ?', [
        claim.passId,
      ]),
    ).toEqual({ recipient: originalEmail });
    const outbox = await first<{ payload: string }>(
      kit.env.DB,
      "SELECT payload FROM outbox WHERE kind = 'email' AND pass_id = ?",
      [claim.passId],
    );
    if (!outbox) throw new Error('Missing claimed issuance email');
    expect(JSON.parse(outbox.payload)).toMatchObject({ to: originalEmail });
  }, 60_000);

  it.each([
    'uncertain',
    'failed',
    'token',
    'reference',
    'release',
    'reserved ID',
    'revision',
  ] as const)(
    'refuses to issue when the retained item changes %s immediately before INSERT',
    async (change) => {
      const { release } = await approved();
      const claim = await startedWebhookIssuance(release);
      const before = await objects();
      await expect(
        atMutation(
          'passes',
          async (db) => {
            expect(
              await first(
                db,
                `SELECT state, token, claim_pass_id FROM connection_webhook_items
          WHERE retention_id = ? AND ordinal = 0`,
                [claim.row.id],
              ),
            ).toEqual({
              state: 'started',
              token: claim.token,
              claim_pass_id: claim.passId,
            });
            if (change === 'uncertain' || change === 'failed') {
              expect(
                await finishItem(
                  jobAt(db),
                  claim.row,
                  0,
                  claim.token,
                  change,
                  'TEST_RACE',
                  claim.credentialKeysetCommitment,
                ),
              ).toBe(true);
            } else if (change === 'token') {
              expect(
                await finishItem(
                  jobAt(db),
                  claim.row,
                  0,
                  claim.token,
                  'retry',
                  'TEST_RACE',
                  claim.credentialKeysetCommitment,
                ),
              ).toBe(true);
              expect(
                await startNewItem(
                  jobAt(db),
                  claim.row,
                  0,
                  unique(),
                  claim.candidate,
                  claim.snapshot,
                  claim.refHash,
                  claim.credentialKeysetCommitment,
                ),
              ).toBe(true);
            } else if (change === 'reference' || change === 'release') {
              const path = change === 'reference' ? '$.refHash' : '$.expectedRelease.id';
              expect(
                (
                  await run(
                    db,
                    `UPDATE connection_webhook_items SET claim_snapshot = json_set(claim_snapshot, ?, ?)
            WHERE retention_id = ? AND ordinal = 0`,
                    [path, unique(), claim.row.id],
                  )
                ).changes,
              ).toBe(1);
            } else if (change === 'reserved ID') {
              expect(
                (
                  await run(
                    db,
                    `UPDATE connection_webhook_items SET claim_pass_id = ?
            WHERE retention_id = ? AND ordinal = 0`,
                    [kit.fx.ids.id(), claim.row.id],
                  )
                ).changes,
              ).toBe(1);
            } else {
              expect(
                (
                  await run(
                    db,
                    `UPDATE connection_webhook_retention SET revision = revision + 1
            WHERE id = ?`,
                    [claim.row.id],
                  )
                ).changes,
              ).toBe(1);
            }
          },
          () => createPassRow(jobCtxOf(kit), claim.input),
        ),
      ).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
      await assertNoPass(claim.passId);
      expect(
        await first(kit.env.DB, 'SELECT pass_id FROM pass_issuance_deliveries WHERE pass_id = ?', [
          claim.passId,
        ]),
      ).toBeNull();
      expect(await objects()).toEqual(before);
    },
    60_000,
  );

  it('requires the exact retained claim and keyed reference before reserving or publishing', async () => {
    const { release } = await approved();
    const connectionId = await connection(own);
    await run(kit.env.DB, "UPDATE connections SET mode = 'webhook' WHERE id = ?", [connectionId]);
    const state = await first<{ generation: number }>(
      kit.env.DB,
      'SELECT generation FROM connections WHERE id = ?',
      [connectionId],
    );
    if (!state) throw new Error('Missing connection');
    const externalRef = unique();
    const passId = kit.fx.ids.id();
    const retainedClaim = {
      retentionId: kit.fx.ids.id(),
      ordinal: 0,
      token: unique(),
      revision: 0,
      ...(await retainedWebhookRefHash(jobCtxOf(kit), own.orgId, connectionId, externalRef)),
    };
    const input: CreateParams = {
      orgId: own.orgId,
      templateId: release.templateId,
      templateVersion: release.version,
      releaseId: release.id,
      releaseGeneration: release.generation,
      input: { memberName: 'Retained source' },
      mode: 'live',
      source: 'connection',
      connectionId,
      connectionGeneration: state.generation,
      credentialKeysetCommitment,
      expectedConnectionMode: 'webhook',
      externalRef,
      execution: { kind: 'connection', connectionId, generation: state.generation },
      actor: { type: 'connection', id: connectionId },
      reservedPassId: passId,
      retainedClaim,
    };
    const before = await objects();
    const invalid = [
      { ...input, retainedClaim: undefined },
      { ...input, reservedPassId: undefined },
      { ...input, retainedClaim: { ...retainedClaim, refHash: 'f'.repeat(64) } },
      { ...input, retainedClaim: { ...retainedClaim, credentialKeysetCommitment: 'f'.repeat(64) } },
      { ...input, externalRef: `${externalRef}-other` },
      { ...input, expectedConnectionMode: 'poll' },
      { ...input, releaseId: undefined },
    ] as CreateParams[];
    for (const attempt of invalid) {
      await expect(
        atMutation(
          'passes',
          async () => {
            throw new Error('Invalid claim reached INSERT');
          },
          () => createPassRow(jobCtxOf(kit), attempt),
          0,
        ),
      ).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
      await assertNoPass(passId);
      expect(await objects()).toEqual(before);
    }
    // Even a correctly formed commitment cannot authorize an absent or finished claim.
    await expect(createPassRow(jobCtxOf(kit), input)).rejects.toMatchObject({
      code: 'PASS_CONFLICT',
    });
    await assertNoPass(passId);
    expect(await objects()).toEqual(before);
  }, 60_000);

  it('persists the approved release for a genuine connection run', async () => {
    const { template, release } = await approved();
    const draft = await imported(own, template.name, 2);
    expect(draft.templateId).toBe(template.templateId);
    expect(draft.version).not.toBe(release.version);
    const connectionId = await connection(own);
    const input = connectionInput(own, release, connectionId);
    await expect(
      createPassFromConnection(jobCtxOf(kit), { ...input, expectedRelease: null }),
    ).rejects.toMatchObject({ status: 409, code: 'TEMPLATE_RELEASE_REQUIRED' });
    await expect(
      createPassFromConnection(jobCtxOf(kit), {
        ...input,
        expectedRelease: { ...input.expectedRelease, version: 'unreviewed-version' },
      }),
    ).rejects.toMatchObject({ status: 409, code: 'TEMPLATE_RELEASE_CONFLICT' });
    expect(
      await first(
        kit.env.DB,
        'SELECT id FROM passes WHERE connection_id = ? AND external_ref = ?',
        [connectionId, input.externalRef],
      ),
    ).toBeNull();
    const { passId } = await createPassFromConnection(jobCtxOf(kit), input);
    await assertIssued(passId, own, release);
    expect(
      await first(kit.env.DB, 'SELECT connection_id, external_ref FROM passes WHERE id = ?', [
        passId,
      ]),
    ).toEqual({ connection_id: connectionId, external_ref: input.externalRef });
  }, 60_000);

  it('does not let an active template version bypass approval for a connection', async () => {
    const template = await imported(own);
    const connectionId = await connection(own);
    const externalRef = unique();
    const before = await objects();
    const legacyInput = {
      orgId: own.orgId,
      mode: 'live' as const,
      templateId: template.templateId,
      templateVersion: template.version,
      expectedRelease: null,
      connectionId,
      generation: 1,
      credentialKeysetCommitment,
      expectedConnectionMode: 'poll' as const,
      externalRef,
      fields: { memberName: 'Unapproved source' },
      sendEmail: false,
    };
    await expect(createPassFromConnection(jobCtxOf(kit), legacyInput)).rejects.toMatchObject({
      status: 409,
      code: 'TEMPLATE_RELEASE_REQUIRED',
    });
    expect(
      await first(
        kit.env.DB,
        'SELECT id FROM passes WHERE connection_id = ? AND external_ref = ?',
        [connectionId, externalRef],
      ),
    ).toBeNull();
    expect(await objects()).toEqual(before);
  }, 60_000);

  it.each(['generation', 'strategy'] as const)(
    'keeps the issued pass but rejects email when the source %s changes at the outbox insert',
    async (change) => {
      const { release } = await approved();
      const connectionId = await connection(own);
      const input = {
        ...connectionInput(own, release, connectionId),
        expectedConnectionMode: 'poll' as const,
      };
      const emails = kit.mailer.sent.length;
      let passId = '';
      await expect(
        atMutation(
          'outbox',
          async (db) => {
            const pass = await first<{ id: string; release_id: string }>(
              db,
              'SELECT id, release_id FROM passes WHERE connection_id = ? AND external_ref = ?',
              [connectionId, input.externalRef],
            );
            if (!pass) throw new Error('Expected a committed connection pass');
            passId = pass.id;
            expect(pass.release_id).toBe(release.id);
            await run(
              db,
              change === 'generation'
                ? 'UPDATE connections SET generation = generation + 1 WHERE id = ?'
                : "UPDATE connections SET mode = 'webhook' WHERE id = ?",
              [connectionId],
            );
          },
          () => createPassFromConnection(jobCtxOf(kit), input),
        ),
      ).rejects.toMatchObject({ code: 'DELIVERY_STALE' });
      await assertIssued(passId, own, release);
      expect(await all(kit.env.DB, 'SELECT id FROM outbox WHERE pass_id = ?', [passId])).toEqual(
        [],
      );
      expect(kit.mailer.sent).toHaveLength(emails);
    },
    60_000,
  );

  it.each(['connection generation', 'release generation'] as const)(
    'fences a changed %s after upload and permits a fresh run',
    async (change) => {
      const { template, release } = await approved();
      const connectionId = await connection(own);
      const input = connectionInput(own, release, connectionId);
      const before = await objects();
      const emails = kit.mailer.sent.length;
      let passId = '';
      let latest: Release | null = null;
      let failure: unknown;
      try {
        await atMutation(
          'passes',
          async (db) => {
            passId = await pendingPassId(before);
            if (change === 'connection generation')
              await run(db, 'UPDATE connections SET generation = generation + 1 WHERE id = ?', [
                connectionId,
              ]);
            else latest = await publish(own, template, 'live', release.generation);
          },
          () => createPassFromConnection(jobCtxOf(kit), input),
        );
      } catch (error) {
        failure = error;
      }
      expect([409, 412]).toContain((failure as { status?: number } | undefined)?.status);
      await assertNoPass(passId);
      expect(
        await first(
          kit.env.DB,
          'SELECT id FROM passes WHERE connection_id = ? AND external_ref = ?',
          [connectionId, input.externalRef],
        ),
      ).toBeNull();
      expect(await objects()).toEqual(before);
      expect(kit.mailer.sent).toHaveLength(emails);
      const selected = latest ? (latest as Release) : release;
      const retried = await createPassFromConnection(jobCtxOf(kit), {
        ...input,
        generation: change === 'connection generation' ? 2 : 1,
        expectedRelease: {
          id: selected.id,
          generation: selected.generation,
          version: selected.version,
        },
      });
      await assertIssued(retried.passId, own, selected);
    },
    60_000,
  );
});
