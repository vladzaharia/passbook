import { expect, it } from 'vitest';
import { fakeAuth } from '../../../test/helpers/fake-auth.ts';
import { createApp } from '../app.ts';
import { operationSecurity } from './openapi-security.ts';

type Doc = { paths: Record<string, Record<string, { 'x-feature'?: unknown }>> };

/**
 * Every operation that declares `RouteAuth.feature`, exactly. A route gated by an entitlement needs its
 * line here (and an `auth` declaration); the list grows with MT4 and MT5 and never holds a guess.
 * Operations that only take the key-level `api` gate (every API-key call) carry no `x-feature`.
 */
const FEATURE_ROUTES: Record<string, unknown> = {
  'post /api/v1/templates/uploads': 'templates.uploads',
  'post /api/v1/templates/{id}/scan-setup': 'scanning.devices',
  // Declared with `xFeature` (documentation): the service and its grant enforce them.
  'post /api/v1/passes/{id}/prints': 'print',
  'post /api/v1/nfc/passes/{passId}/tags': { key: 'nfc', atLeast: 'basic' },
  'post /api/v1/nfc/passes/{passId}/tags/assign': { key: 'nfc', atLeast: 'basic' },
  'patch /api/v1/nfc/bindings/{bindingId}': { key: 'nfc', atLeast: 'basic' },
  'post /api/v1/nfc/passes/{passId}/enrollments': { key: 'nfc', atLeast: 'basic' },
  'post /api/v1/nfc/keysets': { key: 'nfc', atLeast: 'secure' },
  'post /api/v1/orgs/{orgId}/identities/apple': 'identity.managed',
  'post /api/v1/orgs/{orgId}/wallet-accounts/google/managed': 'identity.managed',
};

it('writes x-feature on exactly the operations that declare a feature', () => {
  const app = createApp({ stores: fakeAuth().stores });
  const doc = app.getOpenAPI31Document({
    openapi: '3.1.0',
    info: { title: 't', version: '1' },
  }) as unknown as Doc;
  const found: Record<string, unknown> = {};
  for (const [path, item] of Object.entries(doc.paths))
    for (const [method, op] of Object.entries(item))
      if (op && typeof op === 'object' && 'x-feature' in op)
        found[`${method} ${path}`] = op['x-feature'];
  expect(found).toEqual(FEATURE_ROUTES);
});

it('carries a level as { key, atLeast } and a flag as its key, on scope and human routes', () => {
  const scope = { scope: 'passes:read', capability: 'passes:read' } as const;
  expect(operationSecurity({ ...scope, feature: 'webhooks' }, 'get')['x-feature']).toBe('webhooks');
  expect(
    operationSecurity({ ...scope, feature: { key: 'nfc', atLeast: 'basic' } }, 'get')['x-feature'],
  ).toEqual({ key: 'nfc', atLeast: 'basic' });
  expect(
    operationSecurity({ human: true, requestMode: true, feature: 'webhooks' }, 'post'),
  ).toMatchObject({ 'x-human-only': true, 'x-feature': 'webhooks' });
  expect(operationSecurity(scope, 'get')).not.toHaveProperty('x-feature');
  expect(operationSecurity({ platform: 'platform:orgs' }, 'get')).not.toHaveProperty('x-feature');
});
