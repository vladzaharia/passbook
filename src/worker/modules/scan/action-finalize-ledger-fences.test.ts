import { beforeAll, describe, expect, it } from 'vitest';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import { first, run, stmt } from '../../platform/db.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import {
  type ActionRequest,
  effects,
  request,
  type Scenario,
  type Suite,
  scenario,
  send,
  signed,
  suite,
} from './action-gate-stale-budget-core-test-fixtures.ts';
import { key, makeLegacyScanPass } from './test-kit.ts';

let base: Suite;
beforeAll(async () => {
  base = await suite();
});

/** An unsealed old baked version lets an extra appear without changing release policy. */
async function legacyExtraScenario(): Promise<Scenario> {
  const { kit } = base;
  const source = await kit.registry.resolve(base.template, 'v1');
  const template = kit.registry.add({
    id: `legacy-fence-${key()}`,
    orgId: null,
    origin: 'baked',
    version: 'v1',
    manifest: source.manifest,
    passJson: source.passJson,
    assets: { 'icon.png': ICON_PNG },
  });
  await persistTemplate(kit.fx, template, { registry: kit.registry });
  const pass = await makeLegacyScanPass(kit.fx, {
    orgId: kit.org.id,
    template,
    personalization: { memberName: 'Private budget member' },
  });
  const scanner = await kit.scanner({ templateIds: [template.id] });
  const manager = await kit.staff('manager');
  return {
    kit,
    template: template.id,
    event: null,
    scanner,
    manager,
    pass,
    managed: null,
    post: (body) => kit.post(scanner.headers, '/actions', body),
  };
}

describe('check-in finalize and ledger fences', () => {
  it.each(['released', 'legacy'] as const)(
    'commits the unchanged %s candidate with its signed ledger and retention proof',
    async (kind) => {
      const s =
        kind === 'legacy'
          ? await legacyExtraScenario()
          : await scenario(base, { event: true, tracked: true, photo: true });
      const outcome = await send(s);
      expect(outcome).toMatchObject({ kind: 'ok', scanId: expect.any(String) });
      if (!outcome.scanId) throw new Error('Missing finalized check-in');
      await signed(s, outcome.scanId);
      const committed = await effects(s.kit.env.DB, s);
      expect(committed.gates).toHaveLength(1);
      expect(committed.scans).toHaveLength(1);
      expect(committed.events).toHaveLength(1);
      expect(committed.retention).toHaveLength(1);
    },
  );
});
