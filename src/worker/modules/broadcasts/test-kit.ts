import { makeApiKey, makeSession, persistTemplate } from '../../../../test/helpers/index.ts';
import type { PassJson, TemplateManifest } from '../../../passkit/types.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { type ApiScope, type AuthStores, denyAllStores } from '../../platform/auth.ts';
import { run } from '../../platform/db.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { createPassRow } from '../passes/create.ts';
import { type FakeWorkflow, type Kit, setupKit, TINY_PNG } from '../passes/pass-test-fixtures.ts';
import type { Pass } from '../passes/repo.ts';
import type { TemplateRelease } from '../templates/releases.ts';

export interface BroadcastKit extends Kit {
  broadcast: FakeWorkflow;
  /** A template with a message field and a gate field that has its own change message. */
  messaging: { id: string };
  /** A template without a message field. */
  plain: { id: string };
  /** A new messaging template released in `modes` only; `makePass` refuses a mode it is not released in. */
  releasedIn(modes: Mode[]): Promise<{ id: string }>;
  /** A template whose Live release is v1 and whose Test release is v2; v2 adds the input `gate2` and a message field. */
  versioned(): Promise<{ id: string }>;
  makePass(input?: {
    orgId?: string;
    templateId?: string;
    mode?: 'live' | 'test';
    holderEmail?: string;
    gate?: string;
    message?: string;
    expires?: string;
    points?: number;
  }): Promise<Pass>;
}

const manifest = (messaging: boolean, extra = false): TemplateManifest => ({
  schema: 1,
  name: messaging ? 'Messaging template' : 'Plain template',
  inputs: {
    type: 'object',
    required: ['memberName'],
    properties: {
      memberName: { type: 'string', minLength: 1 },
      gate: { type: 'string', maxLength: 20 },
      message: { type: 'string', maxLength: 256 },
      // Bound to nothing: changing it never changes the rendered pass.
      note: { type: 'string', maxLength: 40 },
      visits: { type: 'integer', minimum: 0 },
      expires: { type: 'string', format: 'date', title: 'Expires' },
      points: { type: 'integer', minimum: 0, title: 'Points' },
      ...(extra ? { gate2: { type: 'string', maxLength: 20 } } : {}),
    },
  },
  sample: { memberName: 'Alex Morgan' },
  bindings: [
    { to: { field: 'name' }, value: '{{memberName}}' },
    { to: { field: 'gate' }, value: '{{gate}}' },
    { to: { field: 'expires' }, value: '{{expires}}' },
    { to: { field: 'points' }, value: '{{points}}' },
    ...(messaging ? [{ to: { field: 'message' }, value: '{{message}}' }] : []),
  ],
  display: { title: '{{memberName}}' },
  ...(messaging ? { messaging: { input: 'message' } } : {}),
});

const passJson = (messaging: boolean): PassJson =>
  ({
    formatVersion: 1,
    passTypeIdentifier: 'placeholder',
    teamIdentifier: 'placeholder',
    serialNumber: 'placeholder',
    organizationName: 'placeholder',
    description: 'Test pass',
    generic: {
      primaryFields: [{ key: 'name', label: 'Member', value: '' }],
      headerFields: [{ key: 'gate', label: 'Gate', value: '', changeMessage: 'Gate is now %@.' }],
      secondaryFields: [
        { key: 'expires', label: 'Expires', value: '' },
        { key: 'points', label: 'Points', value: '' },
      ],
      backFields: messaging
        ? [{ key: 'message', label: 'Message', value: '', changeMessage: '%@' }]
        : [],
    },
  }) as PassJson;

/** The legacy admin is a tenant member, not an implicit member of every organization. */
export async function addBroadcastAdminMembership(kit: Kit, orgId: string): Promise<void> {
  const invitationId = kit.fx.ids.id();
  const now = kit.clock.now();
  await run(
    kit.env.DB,
    `INSERT INTO org_invitations
      (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
     VALUES (?, ?, 'admin-1@example.test', '["org_admin"]', ?, ?, ?, ?)`,
    [invitationId, orgId, kit.fx.ids.token(), now, now + 3600_000, now],
  );
  await run(
    kit.env.DB,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
     VALUES (?, ?, 'admin-1', ?, '["org_admin"]', ?)`,
    [kit.fx.ids.id(), orgId, invitationId, now],
  );
}

async function seedCreators(kit: Kit): Promise<void> {
  await run(
    kit.env.DB,
    `INSERT OR IGNORE INTO users (id, name, primary_email, status, created_at, last_roles)
     VALUES ('admin-1', 'Admin', 'admin-1@example.test', 'active', 0, '["admin","user"]')`,
  );
  await run(
    kit.env.DB,
    `INSERT OR IGNORE INTO users (id, name, primary_email, status, created_at, last_roles)
     VALUES ('user-1', 'Holder', 'user-1@example.test', 'active', 0, '["user"]')`,
  );
  await addBroadcastAdminMembership(kit, kit.org.id);
}

const WEEK_MS = 7 * 86_400_000;

export interface BroadcastAuth {
  stores: AuthStores;
  admin(options?: { mode?: Mode }): Record<string, string>;
  user(): Record<string, string>;
  apiKey(options: {
    orgId?: string | null;
    scopes: ApiScope[];
    mode?: Mode;
  }): Promise<Record<string, string>>;
}

/**
 * Real persisted credentials for the legacy route suites. Pass `kit.clock` to `createApp` too.
 * Sessions live a week so suites can advance `kit.clock`.
 */
export async function broadcastAuth(
  kit: BroadcastKit,
  origin = 'https://wallet.test',
): Promise<BroadcastAuth> {
  const admin = await makeSession(kit.fx, {
    userId: 'admin-1',
    roles: ['admin', 'user'],
    lifetimeMs: WEEK_MS,
  });
  const user = await makeSession(kit.fx, { userId: 'user-1', lifetimeMs: WEEK_MS });
  return {
    stores: {
      ...denyAllStores,
      sessions: createSessionStore(kit.env, kit.clock),
      apiKeys: createApiKeyStore(kit.env, kit.clock),
    },
    admin: ({ mode }: { mode?: Mode } = {}) => ({
      ...admin.headers,
      origin,
      ...(mode ? { 'x-passbook-mode': mode } : {}),
    }),
    user: () => ({ ...user.headers, origin }),
    async apiKey({
      orgId = null,
      scopes,
      mode = 'live',
    }: {
      orgId?: string | null;
      scopes: ApiScope[];
      mode?: Mode;
    }) {
      const key = await makeApiKey(kit.fx, { orgId, scopes, mode });
      return key.headers;
    },
  };
}

export async function broadcastKit(): Promise<BroadcastKit> {
  const kit = await setupKit();
  await seedCreators(kit);
  const broadcast: FakeWorkflow = {
    created: [],
    async create(options) {
      broadcast.created.push(options);
      return { id: options.id };
    },
  };
  Object.assign(kit.env, { BROADCAST: broadcast });
  const add = async (messaging: boolean) => {
    const id = `tpl-${messaging ? 'msg' : 'plain'}-${kit.fx.ids.token(4)}`;
    const resolved = kit.registry.add({
      id,
      version: 'v1',
      manifest: manifest(messaging),
      passJson: passJson(messaging),
      assets: { 'icon.png': TINY_PNG },
    });
    await persistTemplate(kit.fx, resolved, { registry: kit.registry });
    return { id };
  };
  const messaging = await add(true);
  const plain = await add(false);
  const releases = new Map<string, Promise<TemplateRelease>>();
  const restricted = new Map<string, Set<Mode>>();
  // A broadcast resolves its templates through the mode's release: the two fixtures have one in each mode.
  for (const { id: templateId } of [messaging, plain])
    for (const mode of ['live', 'test'] as const) {
      const version = (await kit.registry.resolve(templateId)).version;
      releases.set(
        JSON.stringify([templateId, kit.org.id, mode]),
        approveAppleRelease(kit, { templateId, version, orgId: kit.org.id, mode }),
      );
    }
  await Promise.all(releases.values());
  return {
    ...kit,
    broadcast,
    messaging,
    plain,
    releasedIn: async (modes) => {
      const created = await add(true);
      const version = (await kit.registry.resolve(created.id)).version;
      for (const mode of modes) {
        releases.set(
          JSON.stringify([created.id, kit.org.id, mode]),
          approveAppleRelease(kit, { templateId: created.id, version, orgId: kit.org.id, mode }),
        );
        await releases.get(JSON.stringify([created.id, kit.org.id, mode]));
      }
      restricted.set(created.id, new Set(modes));
      return created;
    },
    versioned: async () => {
      const id = `tpl-versioned-${kit.fx.ids.token(4)}`;
      for (const [version, messaging, extra, mode] of [
        ['v1', false, false, 'live'],
        ['v2', true, true, 'test'],
      ] as const) {
        const resolved = kit.registry.add({
          id,
          version,
          manifest: manifest(messaging, extra),
          passJson: passJson(messaging),
          assets: { 'icon.png': TINY_PNG },
        });
        await persistTemplate(kit.fx, resolved, { registry: kit.registry });
        await approveAppleRelease(kit, { templateId: id, version, orgId: kit.org.id, mode });
      }
      return { id };
    },
    makePass: async (input = {}) => {
      const orgId = input.orgId ?? kit.org.id;
      const mode = input.mode ?? 'live';
      const templateId = input.templateId ?? messaging.id;
      if (restricted.get(templateId) && !restricted.get(templateId)?.has(mode))
        throw new Error(`Template ${templateId} has no ${mode} release.`);
      const version = (await kit.registry.resolve(templateId)).version;
      const key = JSON.stringify([templateId, orgId, mode]);
      let approval = releases.get(key);
      if (!approval) {
        approval = approveAppleRelease(kit, { templateId, version, orgId, mode });
        releases.set(key, approval);
      }
      const release = await approval;
      return createPassRow(jobCtxOf(kit), {
        orgId,
        templateId,
        templateVersion: release.version,
        releaseId: release.id,
        releaseGeneration: release.generation,
        input: {
          memberName: 'Alex',
          ...(input.gate !== undefined ? { gate: input.gate } : {}),
          ...(input.message !== undefined ? { message: input.message } : {}),
          ...(input.expires !== undefined ? { expires: input.expires } : {}),
          ...(input.points !== undefined ? { points: input.points } : {}),
        },
        holderEmail: input.holderEmail ?? null,
        source: 'manual',
        mode,
        execution: { kind: 'system' },
        actor: { type: 'system', id: null },
      });
    },
  };
}
