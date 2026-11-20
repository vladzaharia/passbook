import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeOrg } from '../../../../test/helpers/index.ts';
import {
  TemplateApprovalSchema,
  TemplateCandidateSchema,
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
const SCOPES = [
  'templates:read',
  'templates:write',
  'templates:review',
  'templates:publish',
  'passes:write',
  'passes:read',
];
const DAY = 86_400_000;

let kit: BlueprintKit;
let app: ReturnType<typeof createApp>;

/** An API key row: a service key acts as `createdBy`, a personal key as `membershipId`. */
async function keyRow(
  orgId: string,
  o: {
    mode: 'test' | 'live';
    createdBy?: string;
    kind?: 'service' | 'personal';
    membershipId?: string;
    templateIds?: string[];
  },
) {
  const id = kit.f.ids.id();
  const prefix = kit.f.ids.token(6);
  const secret = `wlt_${prefix}_${kit.f.ids.token()}`;
  const personal = o.kind === 'personal';
  await run(
    kit.env.DB,
    `INSERT INTO api_keys (id, org_id, name, prefix, key_hash, scopes, mode, created_by, created_at,
       kind, membership_id, expires_at, restricted)
     VALUES (?, ?, 'Test key', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      orgId,
      prefix,
      await sha256Hex(secret),
      JSON.stringify(SCOPES),
      o.mode,
      o.createdBy ?? null,
      kit.clock.now(),
      o.kind ?? 'service',
      o.membershipId ?? null,
      personal ? kit.clock.now() + 30 * DAY : null,
      o.templateIds ? 1 : 0,
    ],
  );
  for (const templateId of o.templateIds ?? [])
    await run(
      kit.env.DB,
      "INSERT INTO api_key_resources (key_id, kind, value) VALUES (?, 'template', ?)",
      [id, templateId],
    );
  return { authorization: `Bearer ${secret}` };
}

const send = (method: string, path: string, headers: Record<string, string>, body: unknown = {}) =>
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
      body: JSON.stringify(body),
    },
    kit.env,
  );

/** A fresh org, its admin, and a template with a candidate, made by an unlimited Test key. */
async function setup() {
  const org = await makeOrg(kit.f);
  const owner = await kit.member(org.id, ['org_admin']);
  const membership = await first<{ id: string }>(
    kit.env.DB,
    'SELECT id FROM org_memberships WHERE org_id = ? AND user_id = ?',
    [org.id, owner.userId],
  );
  const service = await keyRow(org.id, { mode: 'test', createdBy: owner.userId });
  const used = await send('POST', `/templates/${STORE}/use`, service, {
    orgId: org.id,
    name: 'Acts as',
  });
  const template = (await used.json()) as {
    id: string;
    activeVersion: string | null;
    versions: { version: string }[];
  };
  const scope = { orgId: org.id, mode: 'test', provider: 'apple' } as const;
  const made = await send('POST', `/templates/${template.id}/candidates`, service, {
    ...scope,
    version: template.activeVersion ?? template.versions[0]?.version ?? '',
  });
  const candidate = TemplateCandidateSchema.parse(await made.json());
  return { org, owner, memberId: membership?.id ?? '', template, scope, candidate, service };
}

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

describe('a key limited to templates on the release path', () => {
  it('is refused on blueprint use, candidates, approve, releases and preview', async () => {
    const t = await setup();
    const limited = await keyRow(t.org.id, {
      mode: 'test',
      createdBy: t.owner.userId,
      templateIds: [t.template.id],
    });
    const id = t.template.id;
    const calls: [string, string, unknown][] = [
      ['POST', `/templates/${STORE}/use`, { orgId: t.org.id, name: 'Limited' }],
      ['POST', `/templates/${id}/candidates`, { ...t.scope, version: '1' }],
      [
        'POST',
        `/templates/${id}/candidates/${t.candidate.id}/approve`,
        { ...t.scope, candidateHash: t.candidate.candidateHash, alone: true },
      ],
      ['POST', `/templates/${id}/releases`, { ...t.scope, candidateId: t.candidate.id }],
      ['POST', `/templates/${id}/preview`, {}],
    ];
    for (const [method, path, body] of calls)
      await expectProblem(await send(method, path, limited, body), 403, [
        'API_KEY_RESTRICTED_ROUTE',
      ]);
  });
});

describe('who a key acts as on the release path', () => {
  it('a personal key acts as its membership, with no creator on the row', async () => {
    const t = await setup();
    const personal = await keyRow(t.org.id, {
      mode: 'test',
      kind: 'personal',
      membershipId: t.memberId,
    });
    const res = await send(
      'POST',
      `/templates/${t.template.id}/candidates/${t.candidate.id}/approve`,
      personal,
      { ...t.scope, candidateHash: t.candidate.candidateHash, alone: true },
    );
    expect(res.status, await res.clone().text()).toBe(201);
    expect(TemplateApprovalSchema.parse(await res.json())).toMatchObject({
      kind: 'test',
      reviewerId: t.owner.userId,
    });
    const audited = await first<{ detail: string }>(
      kit.env.DB,
      "SELECT detail FROM audit_log WHERE target_id = ? AND action = 'template.approved_alone'",
      [t.template.id],
    );
    expect(JSON.parse(audited?.detail ?? '{}')).toMatchObject({
      actingUserId: t.owner.userId,
      membershipId: t.memberId,
    });
  });

  it('a personal key is held to its member: a role without review cannot approve', async () => {
    const t = await setup();
    const reader = await kit.member(t.org.id, ['read_only']);
    const readerMembership = await first<{ id: string }>(
      kit.env.DB,
      'SELECT id FROM org_memberships WHERE org_id = ? AND user_id = ?',
      [t.org.id, reader.userId],
    );
    const personal = await keyRow(t.org.id, {
      mode: 'test',
      kind: 'personal',
      membershipId: readerMembership?.id ?? '',
    });
    const res = await send(
      'POST',
      `/templates/${t.template.id}/candidates/${t.candidate.id}/approve`,
      personal,
      { ...t.scope, candidateHash: t.candidate.candidateHash, alone: true },
    );
    expect(res.status).toBe(403);
  });

  it('a service key approves and releases in Test only, never in Live', async () => {
    const t = await setup();
    const live = await keyRow(t.org.id, { mode: 'live', createdBy: t.owner.userId });
    const liveScope = { ...t.scope, mode: 'live' };
    const body = { ...liveScope, candidateHash: t.candidate.candidateHash, alone: true };
    await expectProblem(
      await send(
        'POST',
        `/templates/${t.template.id}/candidates/${t.candidate.id}/approve`,
        live,
        body,
      ),
      403,
      'KEY_TEST_ONLY',
    );
    await expectProblem(
      await send('POST', `/templates/${t.template.id}/releases`, live, {
        ...liveScope,
        candidateId: t.candidate.id,
        approvalId: kit.f.ids.id(),
        candidateHash: t.candidate.candidateHash,
        expectedGeneration: 0,
      }),
      403,
      'KEY_TEST_ONLY',
    );
  });
});
