import { describe, expect, it } from 'vitest';
import { fakeAuth } from '../../../test/helpers/index.ts';
import { validateAgainst } from '../../../test/helpers/openapi-validate.ts';
import { WEBHOOK_EVENT_TYPES } from '../../shared/contracts/webhooks.ts';
import { createApp } from '../app.ts';
import { buildEnvelope, testEnvelope } from '../modules/webhooks/payload.ts';
import { buildOpenApiDocument } from './openapi-document.ts';

const doc = buildOpenApiDocument(createApp({ stores: fakeAuth().stores })) as {
  webhooks: Record<
    string,
    { post: { requestBody: { content: Record<string, { schema: { $ref: string } }> } } }
  >;
  components: { schemas: Record<string, object> };
};

/** Ledger data for the types whose allowlist has required fields. */
const DATA: Partial<Record<string, object>> = {
  'pass.channels_changed': { channel: 'paper', from: 'off', to: 'on', source: 'pass' },
  'pass.printed': { printId: 'pr1', generation: 1 },
  'pass.print_voided': { printId: 'pr1' },
  'pass.replaced': { replacedBy: 'p2' },
};

describe('openapi webhooks', () => {
  it('lists every event type with a component body', () => {
    expect(Object.keys(doc.webhooks).sort()).toEqual([...WEBHOOK_EVENT_TYPES].sort());
    for (const hook of Object.values(doc.webhooks)) {
      const ref = hook.post.requestBody.content['application/json']?.schema.$ref;
      expect(ref).toMatch(/^#\/components\/schemas\/[A-Za-z]+Event$/);
      expect(doc.components.schemas[ref?.split('/').pop() ?? '']).toBeTruthy();
    }
  });

  it('validates the events the dispatcher builds against their component', () => {
    for (const type of WEBHOOK_EVENT_TYPES) {
      const event =
        type === 'webhook.test'
          ? testEnvelope({ id: 'e1', orgId: 'o1', mode: 'live', now: 1764000000000 })
          : buildEnvelope({
              seq: 1,
              eventId: 'e1',
              orgId: 'o1',
              mode: 'live',
              passId: 'p1',
              templateId: 't1',
              externalId: null,
              type,
              kind: type,
              device: null,
              deviceCount: null,
              actorType: null,
              data: JSON.stringify(DATA[type] ?? {}),
              at: 1764000000000,
            });
      const ref = doc.webhooks[type]?.post.requestBody.content['application/json']?.schema.$ref;
      expect(validateAgainst(doc, { $ref: ref }, event), type).toEqual([]);
    }
  });
});
