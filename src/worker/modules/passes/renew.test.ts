import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeTemplate, saveOrgSettings, TEST_NOW } from '../../../../test/helpers/index.ts';
import { PassDetailSchema } from '../../../shared/contracts/passes.ts';
import { createApp } from '../../app.ts';
import { all } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { createPassRow } from './create.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { getPass } from './repo-read-pass.ts';
import { releaseStamps, stampCard, stampVersion } from './stamps-test-fixtures.ts';
import { setupTenantTestAuth, type TenantTestAuth } from './tenant-test-fixtures.ts';

let kit: Kit;
let auth: TenantTestAuth;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  kit = await setupKit({
    template: (id) => {
      const t = makeTemplate({ id });
      const props = t.resolved.manifest.inputs.properties as Record<string, unknown>;
      props.term_start = { type: 'string' };
      props.term_anchor = { type: 'string' };
      t.resolved.manifest.behaviors = [
        {
          use: 'term',
          version: 1,
          config: { start: 'term_start', anchor: 'term_anchor', unit: 'months', length: 1 },
        },
      ];
      return t;
    },
  });
  await saveOrgSettings(kit.env.DB, kit.org.id, { 'org.timeZone': 'UTC' }, TEST_NOW);
  auth = await setupTenantTestAuth(kit);
  app = createApp({ stores: auth.stores, clock: kit.clock });
});

const member = (start: string) => {
  const release = kit.liveRelease;
  if (!release) throw new Error('missing release');
  return createPassRow(jobCtxOf(kit), {
    orgId: kit.org.id,
    templateId: kit.template.id,
    templateVersion: release.version,
    releaseId: release.id,
    releaseGeneration: release.generation,
    input: { memberName: 'Alex Morgan', term_start: start },
    holderEmail: null,
    source: 'manual',
    mode: 'live',
    execution: { kind: 'system' },
    actor: { type: 'system', id: null },
  });
};

const renew = (passId: string, headers = auth.admin()) =>
  app.request(
    `https://wallet.test/api/v1/passes/${passId}/renew`,
    {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: '{}',
    },
    kit.env,
  );
const endOf = async (res: Response) => {
  expect(res.status).toBe(200);
  return PassDetailSchema.parse(await res.json()).term?.end;
};

describe('renew a term', () => {
  it('keeps the day of the month through consecutive early renewals', async () => {
    const pass = await member('2030-01-31T10:00:00Z');
    expect(PassDetailSchema.parse(await (await renew(pass.id)).json()).term?.input).toBe(
      'term_start',
    );
    const ends = [];
    for (let i = 0; i < 3; i++) ends.push(await endOf(await renew(pass.id)));
    // The first renewal above ended 2030-03-31; three more follow.
    expect(ends).toEqual(['2030-04-30T10:00:00Z', '2030-05-31T10:00:00Z', '2030-06-30T10:00:00Z']);
    const stored = await getPass(kit.env.DB, pass.id);
    expect(stored?.personalization.term_anchor).toBe('2030-01-31T10:00:00.000Z');
    expect(stored?.fieldSources.term_start).toBe('manual');
    const audits = await all<{ action: string }>(
      kit.env.DB,
      "SELECT action FROM audit_log WHERE target_id = ? AND action = 'pass.term.renew'",
      [pass.id],
    );
    expect(audits).toHaveLength(4);
  });

  it('starts a lapsed renewal now, and re-anchors on its day', async () => {
    // The term ended 28 Feb 2026; the clock is later.
    const pass = await member('2026-01-31T10:00:00Z');
    const now = new Date(kit.clock.now());
    const end = new Date(now);
    end.setUTCMonth(end.getUTCMonth() + 1);
    expect(await endOf(await renew(pass.id))).toBe(end.toISOString().replace('.000Z', 'Z'));
    const stored = await getPass(kit.env.DB, pass.id);
    expect(stored?.personalization.term_anchor).toBe(now.toISOString());
  });

  it('refuses a pass without a term, and needs a pass writer', async () => {
    await stampVersion(kit, 'tpl-no-term', 'v1', 10);
    const plain = await stampCard(kit, await releaseStamps(kit, 'tpl-no-term', 'v1'), 0);
    const res = await renew(plain.id);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'TERM_NONE' });
    const pass = await member('2031-01-31T10:00:00Z');
    await expectProblem(await renew(pass.id, auth.user()), 403, 'FORBIDDEN');
  });
});
