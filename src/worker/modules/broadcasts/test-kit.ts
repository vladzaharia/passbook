import { persistTemplate } from '../../../../test/helpers/index.ts';
import type { PassJson, TemplateManifest } from '../../../passkit/types.ts';
import { run } from '../../platform/db.ts';
import { createPassRow } from '../passes/create.ts';
import type { Pass } from '../passes/repo.ts';
import { type FakeWorkflow, type Kit, setupKit, TINY_PNG } from '../passes/test-kit.ts';

export interface BroadcastKit extends Kit {
  broadcast: FakeWorkflow;
  /** A template with a message field and a gate field that has its own change message. */
  messaging: { id: string };
  /** A template without a message field. */
  plain: { id: string };
  makePass(input?: {
    orgId?: string;
    templateId?: string;
    mode?: 'live' | 'test';
    gate?: string;
    message?: string;
  }): Promise<Pass>;
}

const manifest = (messaging: boolean): TemplateManifest => ({
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
    },
  },
  sample: { memberName: 'Alex Morgan' },
  bindings: [
    { to: { field: 'name' }, value: '{{memberName}}' },
    { to: { field: 'gate' }, value: '{{gate}}' },
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
      backFields: messaging
        ? [{ key: 'message', label: 'Message', value: '', changeMessage: '%@' }]
        : [],
    },
  }) as PassJson;

/** The fake admin and the first fake API keys as real rows: a launch checks its creator is live. */
async function seedCreators(db: D1Database): Promise<void> {
  const keys = Array.from({ length: 40 }, (_, i) =>
    run(
      db,
      `INSERT OR IGNORE INTO api_keys (id, name, prefix, key_hash, scopes, created_at)
       VALUES (?, 'Test key', ?, ?, '[]', 0)`,
      [`key-${i + 1}`, `pre${i + 1}`, `hash${i + 1}`],
    ),
  );
  await Promise.all([
    run(
      db,
      `INSERT OR IGNORE INTO users (id, name, primary_email, status, created_at, last_roles)
       VALUES ('admin-1', 'Admin', 'admin-1@example.test', 'active', 0, '["admin","user"]')`,
    ),
    ...keys,
  ]);
}

export async function broadcastKit(): Promise<BroadcastKit> {
  const kit = await setupKit();
  await seedCreators(kit.env.DB);
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
    await persistTemplate(kit.fx, resolved);
    return { id };
  };
  const messaging = await add(true);
  const plain = await add(false);
  return {
    ...kit,
    broadcast,
    messaging,
    plain,
    makePass: (input = {}) =>
      createPassRow(kit.ctx, {
        orgId: input.orgId ?? kit.org.id,
        templateId: input.templateId ?? messaging.id,
        input: {
          memberName: 'Alex',
          ...(input.gate !== undefined ? { gate: input.gate } : {}),
          ...(input.message !== undefined ? { message: input.message } : {}),
        },
        source: 'manual',
        mode: input.mode ?? 'live',
        actor: { type: 'system', id: null },
      }),
  };
}
