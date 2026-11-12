import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { makePass, makeTemplate } from '../../../test/helpers/index.ts';
import { effectiveReleaseIdSql } from '../modules/templates/repo-release-heads.ts';
import { grant } from './authority.ts';
import { releaseHead } from './authority-checks.ts';
import { type seedAuthority, setupGrant } from './authority-test-fixtures.ts';
import { first, run } from './db.ts';

const db = env.DB;
const hex = (n: number) => n.toString(16).padStart(64, '0');
type Seed = Awaited<ReturnType<typeof seedAuthority>>;

/** A baked template at `orgId` (null: platform) with its saved content hash, as baked sync leaves it. */
async function bakedTemplate(templateId: string, orgId: string | null) {
  await run(db, "UPDATE templates SET org_id = ?, origin = 'baked' WHERE id = ?", [
    orgId,
    templateId,
  ]);
  const version = await first<{ version: string }>(
    db,
    'SELECT version FROM template_versions WHERE template_id = ?',
    [templateId],
  );
  if (!version) throw new Error('Missing version');
  await run(
    db,
    `INSERT INTO template_version_hashes (template_id, version, content_hash, asset_hashes, created_at)
     VALUES (?, ?, ?, '[]', 1)`,
    [templateId, version.version, hex(9)],
  );
  return version.version;
}

let counter = 1;
async function systemRelease(
  s: Seed,
  templateId: string,
  version: string,
  orgId: string | null,
  generation: number,
  previous: string | null,
) {
  const id = s.f.ids.id();
  await run(
    db,
    `INSERT INTO template_releases (id, template_id, org_id, mode, provider, generation, version, candidate_hash,
       content_hash, adapter_revision, adapter_capabilities, audience_policy_revision, source, action,
       previous_release_id, created_at)
     VALUES (?, ?, ?, 'live', 'apple', ?, ?, ?, ?, 1, '["apple-passkit"]', 1, 'system', 'system', ?, 1)`,
    [id, templateId, orgId, generation, version, hex(counter++), hex(9), previous],
  );
  return id;
}

const effective = async (templateId: string, orgId: string) =>
  (
    await first<{ id: string | null }>(
      db,
      `SELECT (${effectiveReleaseIdSql({
        templateIdSql: `'${templateId}'`,
        orgIdSql: `'${orgId}'`,
        modeSql: "'live'",
        providerSql: "'apple'",
      })}) AS id`,
    )
  )?.id ?? null;

describe('release head precedence', () => {
  const attempt = (
    g: Awaited<ReturnType<typeof setupGrant>>,
    templateId: string,
    releaseId: string,
  ) =>
    grant(g.route, {
      purpose: 'org_mode.pass.publish',
      principal: g.member(),
      checks: [releaseHead(templateId, 'live', 'apple', releaseId)],
    })
      .commit()
      .then(() => 'ok')
      .catch((e: { code: string }) => e.code);

  it('an assigned baked template uses its own org head, and another org gets no head', async () => {
    const mine = await setupGrant('rh-assigned');
    const other = await setupGrant('rh-assigned-other');
    const templateId = mine.s.template.resolved.id;
    const version = await bakedTemplate(templateId, mine.s.org.id);
    const release = await systemRelease(mine.s, templateId, version, mine.s.org.id, 1, null);
    expect(await attempt(mine, templateId, release)).toBe('ok');
    expect(await effective(templateId, mine.s.org.id)).toBe(release);
    expect(await attempt(other, templateId, release)).toBe('TEMPLATE_RELEASE_CHANGED');
    expect(await effective(templateId, other.s.org.id)).toBeNull();
  });

  it('an org release left by a past assignment does not shadow the platform head', async () => {
    const g = await setupGrant('rh-history');
    const templateId = g.s.template.resolved.id;
    const version = await bakedTemplate(templateId, g.s.org.id);
    const historic = await systemRelease(g.s, templateId, version, g.s.org.id, 1, null);
    await run(db, 'UPDATE templates SET org_id = NULL WHERE id = ?', [templateId]);
    const platform = await systemRelease(g.s, templateId, version, null, 1, null);
    // Unassigned again: the platform head is the head for the org that once owned it.
    expect(await attempt(g, templateId, platform)).toBe('ok');
    expect(await attempt(g, templateId, historic)).toBe('TEMPLATE_RELEASE_CHANGED');
    expect(await effective(templateId, g.s.org.id)).toBe(platform);
  });

  it('a platform release is not a head for a template that is not baked', async () => {
    const g = await setupGrant('rh-uploaded');
    const templateId = g.s.template.resolved.id;
    const version = await bakedTemplate(templateId, null);
    const platform = await systemRelease(g.s, templateId, version, null, 1, null);
    expect(await attempt(g, templateId, platform)).toBe('ok');
    await run(db, "UPDATE templates SET origin = 'uploaded' WHERE id = ?", [templateId]);
    expect(await attempt(g, templateId, platform)).toBe('TEMPLATE_RELEASE_CHANGED');
    expect(await effective(templateId, g.s.org.id)).toBeNull();
  });

  it('a release appended mid-request refuses its own scope and no other', async () => {
    const g = await setupGrant('rh-mid');
    const x = g.s.template.resolved.id;
    const y = `tpl-rh-mid-y-${counter++}`;
    await makePass(g.s.f, { orgId: g.s.org.id, template: makeTemplate({ id: y }).resolved });
    const xVersion = await bakedTemplate(x, g.s.org.id);
    const yVersion = await bakedTemplate(y, g.s.org.id);
    const x1 = await systemRelease(g.s, x, xVersion, g.s.org.id, 1, null);
    const y1 = await systemRelease(g.s, y, yVersion, g.s.org.id, 1, null);
    const forX = grant(g.route, {
      purpose: 'org_mode.pass.publish',
      principal: g.member(),
      checks: [releaseHead(x, 'live', 'apple', x1)],
    });
    const forY = grant(g.route, {
      purpose: 'org_mode.pass.publish',
      principal: g.member(),
      checks: [releaseHead(y, 'live', 'apple', y1)],
    });
    // The release for X lands after both grants were built and before either commits.
    const x2 = await systemRelease(g.s, x, xVersion, g.s.org.id, 2, x1);
    await expect(forY.commit()).resolves.toBeDefined();
    await expect(forX.commit()).rejects.toMatchObject({ code: 'TEMPLATE_RELEASE_CHANGED' });
    expect(await attempt(g, x, x2)).toBe('ok');
    expect(await effective(x, g.s.org.id)).toBe(x2);
  });

  it('refuses once the template is archived, even for the head release', async () => {
    const g = await setupGrant('rh-archived');
    const templateId = g.s.template.resolved.id;
    const version = await bakedTemplate(templateId, g.s.org.id);
    const release = await systemRelease(g.s, templateId, version, g.s.org.id, 1, null);
    const pending = grant(g.route, {
      purpose: 'org_mode.pass.publish',
      principal: g.member(),
      checks: [releaseHead(templateId, 'live', 'apple', release)],
    });
    await run(db, "UPDATE templates SET status = 'archived' WHERE id = ?", [templateId]);
    await expect(pending.commit()).rejects.toMatchObject({ code: 'TEMPLATE_RELEASE_CHANGED' });
    expect(await effective(templateId, g.s.org.id)).toBeNull();
  });
});
