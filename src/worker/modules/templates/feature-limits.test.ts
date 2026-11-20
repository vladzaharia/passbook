import { beforeAll, describe, expect, it } from 'vitest';
import {
  type Fixtures,
  fixtures,
  limitSuite,
  makeEnv,
  makeOrg,
  type Refused,
  setLimit,
} from '../../../../test/helpers/index.ts';
import { ManualClock } from '../../platform/clock.ts';
import { first } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { basicPackage, zipOf } from './package/fixtures.ts';
import { fakeAssets, importZip, setTemplateStatus } from './testing.ts';

let env: AppEnv;
let clock: ManualClock;
let f: Fixtures;
let orgId: string;
let n = 0;

beforeAll(async () => {
  clock = new ManualClock();
  env = await makeEnv({ ASSETS: fakeAssets() });
  f = fixtures(env, clock);
  orgId = (await makeOrg(f)).id;
});

const manifest = (name: string) => ({
  schema: 1,
  name,
  inputs: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
  sample: { name: 'Alex' },
  bindings: [{ to: { field: 'name' }, value: '{{name}}' }],
  display: { title: '{{name}}' },
});

/**
 * A new template through the upload import: the persist stage is where the grant commits. A refused
 * import is rejected like any other (the upload records the code and the sentence), never retried.
 */
const make = async (): Promise<Refused | null> => {
  const name = `Pass design ${++n}`;
  const imported = await importZip(env, clock, {
    orgId,
    zip: zipOf(basicPackage({ 'wallet.template.json': JSON.stringify(manifest(name)) })),
    name,
  });
  if (imported.result !== null) return null;
  const row = await first<{ error: string | null; report: string }>(
    env.DB,
    'SELECT error, report FROM template_imports WHERE upload_id = ?',
    [imported.p.uploadId],
  );
  const issues = (JSON.parse(row?.report ?? '{}') as { issues?: { message: string }[] }).issues;
  return { status: 403, code: row?.error ?? 'none', detail: issues?.[0]?.message ?? '' };
};

/** Templates of the org that are not deleted: what the limit counts. */
const held = async () =>
  (
    await first<{ n: number }>(
      env.DB,
      "SELECT COUNT(*) AS n FROM templates WHERE org_id = ? AND status <> 'deleted'",
      [orgId],
    )
  )?.n ?? 0;

limitSuite(
  'templates',
  async () => ({ db: env.DB, orgId, key: 'templates', create: make, count: held }),
  // The upload records the code and the sentence, not the structured fields.
  { plain: true },
);

describe('template limits', () => {
  it('a deleted template frees its slot', async () => {
    const before = await held();
    await setLimit(env.DB, orgId, 'templates', before);
    const refused = await make();
    expect(refused?.code).toBe('FEATURE_LIMIT_REACHED');
    expect(refused?.detail).toBe(
      `Templates limit reached (${before} of ${before}), ask PassBook for more.`,
    );
    const row = await first<{ id: string }>(
      env.DB,
      "SELECT id FROM templates WHERE org_id = ? AND status = 'active' LIMIT 1",
      [orgId],
    );
    await setTemplateStatus(env.DB, row?.id ?? '', 'deleted', clock.now());
    expect(await held()).toBe(before - 1);
    expect(await make()).toBeNull();
  });
});
