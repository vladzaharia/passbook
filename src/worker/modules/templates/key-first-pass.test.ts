import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeOrg } from '../../../../test/helpers/index.ts';
import {
  TemplateApprovalSchema,
  TemplateCandidateSchema,
  TemplateReleaseSchema,
} from '../../../shared/contracts/template-releases.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { type BlueprintKit, blueprintKit } from './blueprint-test-fixtures.ts';

const ORIGIN = 'https://wallet.test';
const STORE = 'baked:starter-store-card';
const KEY_SCOPES = [
  'templates:read',
  'templates:write',
  'templates:review',
  'templates:publish',
  'passes:write',
  'passes:read',
];

let kit: BlueprintKit;
let app: ReturnType<typeof createApp>;

/** A key made by `userId`, who is the member it acts as. */
async function keyFor(orgId: string, userId: string, mode: 'test' | 'live', scopes = KEY_SCOPES) {
  const id = kit.f.ids.id();
  const prefix = kit.f.ids.token(6);
  const secret = `wlt_${prefix}_${kit.f.ids.token()}`;
  await run(
    kit.env.DB,
    `INSERT INTO api_keys (id, org_id, name, prefix, key_hash, scopes, mode, created_by, created_at)
     VALUES (?, ?, 'Test key', ?, ?, ?, ?, ?, ?)`,
    [
      id,
      orgId,
      prefix,
      await sha256Hex(secret),
      JSON.stringify(scopes),
      mode,
      userId,
      kit.clock.now(),
    ],
  );
  return { authorization: `Bearer ${secret}` };
}

const send = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  app.request(
    `${ORIGIN}/api/v1${path}`,
    {
      method,
      headers: {
        ...headers,
        origin: ORIGIN,
        'content-type': 'application/json',
        'idempotency-key': kit.f.ids.token(),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    kit.env,
  );

beforeAll(async () => {
  kit = await blueprintKit();
  app = createApp({
    stores: {
      ...denyAllStores,
      sessions: createSessionStore(kit.env, kit.clock),
      apiKeys: createApiKeyStore(kit.env, kit.clock),
    },
    clock: kit.clock,
  });
});

describe('a Test key from blueprint to first pass', () => {
  it('walks a fresh org from zero to a pass and a preview', async () => {
    const org = await makeOrg(kit.f);
    const owner = await kit.member(org.id, ['org_admin']);
    const key = await keyFor(org.id, owner.userId, 'test');

    const used = await send('POST', `/templates/${STORE}/use`, key, {
      orgId: org.id,
      name: 'Key Card',
    });
    expect(used.status).toBe(201);
    const template = (await used.json()) as {
      id: string;
      activeVersion: string | null;
      manifest: { sample?: Record<string, unknown> };
      versions: { version: string }[];
    };
    const version = template.activeVersion ?? template.versions[0]?.version ?? '';
    const scope = { orgId: org.id, mode: 'test', provider: 'apple' } as const;

    const made = await send('POST', `/templates/${template.id}/candidates`, key, {
      ...scope,
      version,
    });
    expect(made.status).toBe(201);
    const candidate = TemplateCandidateSchema.parse(await made.json());

    const approvePath = `/templates/${template.id}/candidates/${candidate.id}/approve`;
    const approveBody = { ...scope, candidateHash: candidate.candidateHash };
    await expectProblem(
      await send('POST', approvePath, key, approveBody),
      403,
      'TEMPLATE_SELF_APPROVAL',
    );
    const approved = await send('POST', approvePath, key, { ...approveBody, alone: true });
    expect(approved.status, await approved.clone().text()).toBe(201);
    const approval = TemplateApprovalSchema.parse(await approved.json());
    expect(approval).toMatchObject({ kind: 'test', reviewerId: owner.userId });

    const audited = await first<{ actor_type: string }>(
      kit.env.DB,
      "SELECT actor_type FROM audit_log WHERE target_id = ? AND action = 'template.approved_alone'",
      [template.id],
    );
    expect(audited?.actor_type).toBe('api_key');

    const released = await send('POST', `/templates/${template.id}/releases`, key, {
      ...scope,
      candidateId: candidate.id,
      approvalId: approval.id,
      candidateHash: candidate.candidateHash,
      expectedGeneration: 0,
    });
    expect(released.status).toBe(201);
    const release = TemplateReleaseSchema.parse(await released.json());

    const preview = await send('POST', `/templates/${template.id}/preview`, key, {});
    expect(preview.status).toBe(200);

    const pass = await send('POST', '/passes', key, {
      orgId: org.id,
      templateId: template.id,
      templateVersion: release.version,
      releaseId: release.id,
      releaseGeneration: release.generation,
      mode: 'test',
      input: template.manifest.sample ?? {},
      externalId: 'first-pass',
    });
    expect(pass.status).toBe(201);
  });

  it('refuses a Live key at approve and a Test key outside the scope', async () => {
    const org = await makeOrg(kit.f);
    const owner = await kit.member(org.id, ['org_admin']);
    const test = await keyFor(org.id, owner.userId, 'test');
    const live = await keyFor(org.id, owner.userId, 'live');
    const used = await send('POST', `/templates/${STORE}/use`, test, {
      orgId: org.id,
      name: 'Gate',
    });
    const template = (await used.json()) as {
      id: string;
      activeVersion: string | null;
      versions: { version: string }[];
    };
    const made = await send('POST', `/templates/${template.id}/candidates`, test, {
      orgId: org.id,
      mode: 'test',
      provider: 'apple',
      version: template.activeVersion ?? template.versions[0]?.version ?? '',
    });
    const candidate = TemplateCandidateSchema.parse(await made.json());
    const path = `/templates/${template.id}/candidates/${candidate.id}/approve`;

    const liveCall = await send('POST', path, live, {
      orgId: org.id,
      mode: 'live',
      provider: 'apple',
      candidateHash: candidate.candidateHash,
      alone: true,
    });
    expect(liveCall.status).toBe(403);
    const liveUse = await send('POST', `/templates/${STORE}/use`, live, {
      orgId: org.id,
      name: 'Live',
    });
    expect(liveUse.status).toBe(403);

    const reader = await keyFor(org.id, owner.userId, 'test', ['templates:read']);
    const noScope = await send('POST', path, reader, {
      orgId: org.id,
      mode: 'test',
      provider: 'apple',
      candidateHash: candidate.candidateHash,
      alone: true,
    });
    expect(noScope.status).toBe(403);

    await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE user_id = ?', [
      kit.clock.now(),
      owner.userId,
    ]);
    const gone = await send('POST', path, test, {
      orgId: org.id,
      mode: 'test',
      provider: 'apple',
      candidateHash: candidate.candidateHash,
      alone: true,
    });
    await expectProblem(gone, 403, 'KEY_CREATOR_NOT_MEMBER');
  });

  it('writes the acting user and membership into the audit detail', async () => {
    const row = await first<{ detail: string }>(
      kit.env.DB,
      "SELECT detail FROM audit_log WHERE action = 'template.approved_alone' AND actor_type = 'api_key' ORDER BY rowid DESC LIMIT 1",
    );
    expect(JSON.parse(row?.detail ?? '{}')).toMatchObject({
      actingUserId: expect.any(String),
      membershipId: expect.any(String),
    });
  });

  it('keeps preview inside the key org', async () => {
    const a = await makeOrg(kit.f);
    const b = await makeOrg(kit.f);
    const ownerA = await kit.member(a.id, ['org_admin']);
    const ownerB = await kit.member(b.id, ['org_admin']);
    const keyB = await keyFor(b.id, ownerB.userId, 'test');
    const used = await send('POST', `/templates/${STORE}/use`, keyB, {
      orgId: b.id,
      name: 'B Card',
    });
    const template = (await used.json()) as { id: string };
    const keyA = await keyFor(a.id, ownerA.userId, 'test');
    const res = await send('POST', `/templates/${template.id}/preview`, keyA, {});
    expect(res.status).toBe(404);
  });
});
