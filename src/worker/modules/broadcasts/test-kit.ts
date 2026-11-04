import { persistTemplate } from '../../../../test/helpers/index.ts';
import type { PassJson, TemplateManifest } from '../../../passkit/types.ts';
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

export async function broadcastKit(): Promise<BroadcastKit> {
  const kit = await setupKit();
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
