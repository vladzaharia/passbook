import type { OpenAPIHono } from '@hono/zod-openapi';
import { type makeTemplate, persistTemplate } from '../../../../test/helpers/index.ts';
import type { OrgRole } from '../../../shared/contracts/org-membership.ts';
import { createApp } from '../../app.ts';
import type { AppBindings } from '../../platform/context.ts';
import { eventMember, eventStores } from '../events/test-auth-fixtures.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { type Kit, TINY_PNG } from '../passes/pass-test-fixtures.ts';
import { joinTemplate } from './join-test-fixtures.ts';

export const ORIGIN = 'https://wallet.test';

export interface Caller {
  headers: Record<string, string>;
}

/** A member of the kit's org with these roles, calling the admin routes. */
export async function member(kit: Kit, roles: OrgRole[]): Promise<Caller> {
  return { headers: (await eventMember(kit, kit.org.id, roles)).session.headers };
}

export function adminApp(kit: Kit): OpenAPIHono<AppBindings> {
  return createApp({ stores: eventStores(kit), clock: kit.clock });
}

export function call(
  app: OpenAPIHono<AppBindings>,
  kit: Kit,
  who: Caller,
  method: string,
  path: string,
  body?: unknown,
  extra: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    app.request(
      `${ORIGIN}/api/v1/join-links${path}`,
      {
        method,
        headers: {
          ...who.headers,
          origin: ORIGIN,
          ...extra,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      kit.env,
    ),
  );
}

/** A second platform template in the kit's registry, released in live and test, shaped by `patch`. */
export async function extraTemplate(
  kit: Kit,
  id: string,
  patch: (manifest: ReturnType<typeof makeTemplate>['resolved']['manifest']) => void,
  barcode = '{{pass.scanCode}}',
  modes: ('live' | 'test')[] = ['live', 'test'],
): Promise<string> {
  const base = joinTemplate(id, barcode).resolved;
  const manifest = structuredClone(base.manifest);
  patch(manifest);
  const resolved = kit.registry.add({
    id,
    orgId: null,
    version: 'v1',
    manifest,
    passJson: base.passJson,
    assets: { 'icon.png': TINY_PNG },
  });
  await persistTemplate(kit.fx, resolved, { registry: kit.registry });
  for (const mode of modes) await approveAppleRelease(kit, { templateId: id, version: 'v1', mode });
  return id;
}
