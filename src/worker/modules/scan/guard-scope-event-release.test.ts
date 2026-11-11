import type { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type makeEnv,
  makeOrg,
  makeScanEvent,
  makeScanner,
  makeTemplate,
  persistTemplate,
} from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import type { AppBindings } from '../../platform/context.ts';
import { run } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { ensurePlatformIdentity } from '../identities/repo.ts';
import { overrideDeps } from '../passes/deps.ts';
import { createScannerStore } from './auth-store.ts';
import { createGuardHarness, get, ORIGIN, post, scannerCsrf } from './guard-test-fixtures.ts';
import { pairedSession } from './pairing-session.ts';
import { countOrgTemplates, readValidEventScope } from './repo-scope.ts';

const harness = createGuardHarness();
let { f, clock, fake, orgId } = harness;
const { persistApprovedTemplate } = harness;
const build: typeof harness.build = async (...args) => {
  const result = await harness.build(...args);
  ({ f, clock, fake, orgId } = harness);
  return result;
};

describe('requireScanActor: scope: event release validation', () => {
  let app: Hono<AppBindings>;
  let env: Awaited<ReturnType<typeof makeEnv>>;
  beforeEach(async () => {
    ({ app, env } = await build());
  });

  it.each([
    'empty',
    'deleted',
    'foreign',
    'missing-release',
    'wrong-mode-release',
    'unapproved',
    'invalid-match',
    'invalid-zone',
    'invalid-window',
    'invalid-capacity',
  ] as const)(
    'denies a pinned event with %s scope instead of using scanner templates',
    async (reason) => {
      const own = makeTemplate({ id: f.ids.id(), orgId });
      const otherOrg = reason === 'foreign' ? await makeOrg(f) : null;
      const bad = makeTemplate({ id: f.ids.id(), orgId: otherOrg?.id ?? orgId });
      await persistApprovedTemplate(own);
      if (reason === 'missing-release' || reason === 'unapproved') {
        await persistTemplate(f, bad.resolved, { registry: bad.registry });
        if (reason === 'unapproved') {
          overrideDeps(env, { registry: bad.registry });
          await ensurePlatformIdentity(env, clock.now());
          const api = createApp({
            stores: { ...fake.stores, scanners: createScannerStore(env, clock) },
            clock,
          });
          const candidate = await api.request(
            `${ORIGIN}/api/v1/templates/${bad.resolved.id}/candidates`,
            {
              method: 'POST',
              headers: { ...fake.admin(), 'content-type': 'application/json' },
              body: JSON.stringify({
                orgId,
                mode: 'live',
                provider: 'apple',
                version: bad.resolved.version,
              }),
            },
            env,
          );
          expect(candidate.status).toBe(201);
        }
      } else
        await persistApprovedTemplate(bad, reason === 'wrong-mode-release' ? ['test'] : ['live']);
      const ids =
        reason === 'empty'
          ? []
          : reason === 'invalid-match'
            ? [own.resolved.id]
            : [own.resolved.id, bad.resolved.id];
      const ev = await makeScanEvent(f, { orgId, templateIds: ids });
      if (reason === 'deleted')
        await run(env.DB, "UPDATE templates SET status = 'deleted' WHERE id = ?", [
          bad.resolved.id,
        ]);
      if (reason === 'invalid-match')
        await run(
          env.DB,
          "UPDATE scan_events SET match_input = 'memberName', match_values = '{}' WHERE id = ?",
          [ev.id],
        );
      if (reason === 'invalid-zone')
        await run(env.DB, "UPDATE scan_events SET time_zone = 'Not/A_Zone' WHERE id = ?", [ev.id]);
      if (reason === 'invalid-window')
        await run(env.DB, 'UPDATE scan_events SET opens_at = -1 WHERE id = ?', [ev.id]);
      if (reason === 'invalid-capacity')
        await run(env.DB, 'UPDATE scan_events SET capacity = 1.5 WHERE id = ?', [ev.id]);
      if (
        reason === 'missing-release' ||
        reason === 'wrong-mode-release' ||
        reason === 'unapproved'
      ) {
        expect(
          await countOrgTemplates(env.DB, orgId, 'live', [own.resolved.id, bad.resolved.id]),
        ).toBe(1);
        for (const templateIds of [undefined, [own.resolved.id]]) {
          const response = await post(app, env, fake.admin(), {
            scope: { orgId, eventId: ev.id, templateIds, timeZone: 'UTC' },
          });
          expect(response.status).toBe(404);
        }
        const explicit = await makeScanner(f, {
          orgId,
          templateIds: [bad.resolved.id],
          settings: { acceptAllTemplates: true },
        });
        expect(await (await get(app, env, '/ping', explicit.headers)).json()).toMatchObject({
          event: null,
          templateIds: [],
          settings: { acceptAllTemplates: false },
        });
        expect(
          await pairedSession(
            createServiceContext(env, { clock }),
            explicit.id,
            scannerCsrf(explicit),
          ),
        ).toMatchObject({
          state: 'unassigned',
          scanner: { settings: { acceptAllTemplates: false } },
        });
      }
      const scanner = await makeScanner(f, {
        orgId,
        eventId: ev.id,
        templateIds: [own.resolved.id],
        settings: { acceptAllTemplates: true },
      });
      expect(await readValidEventScope(env.DB, orgId, 'live', ev.id)).toBeNull();
      expect(await (await get(app, env, '/ping', scanner.headers)).json()).toMatchObject({
        event: null,
        templateIds: [],
        settings: { acceptAllTemplates: false },
        invalidScannerScope: true,
      });
      expect(await (await get(app, env, '/dto', scanner.headers)).json()).toMatchObject({
        state: 'unassigned',
        event: null,
        templates: [],
        scanner: { settings: { acceptAllTemplates: false } },
      });
    },
  );
});
