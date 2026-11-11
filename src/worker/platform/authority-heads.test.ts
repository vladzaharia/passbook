import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { grant } from './authority.ts';
import { releaseHead } from './authority-checks.ts';
import { seedAuthority, setupGrant } from './authority-test-fixtures.ts';
import { all, first, run, type SqlValue } from './db.ts';

const db = env.DB;
const HASH = 'a'.repeat(64);
const HASH2 = 'b'.repeat(64);

async function legacyRelease(s: Awaited<ReturnType<typeof seedAuthority>>) {
  const templateId = s.template.resolved.id;
  const version = s.template.resolved.version;
  await run(db, 'UPDATE templates SET org_id = ?, origin = ? WHERE id = ?', [
    s.org.id,
    'uploaded',
    templateId,
  ]);
  const id = s.f.ids.id();
  const inserted = await run(
    db,
    `INSERT INTO template_releases (id, template_id, org_id, mode, provider, generation, version, candidate_hash,
       content_hash, adapter_revision, adapter_capabilities, audience_policy_revision, source, action, created_at)
     VALUES (?, ?, ?, 'live', 'apple', 1, ?, ?, ?, 1, '["apple-passkit"]', 1, 'legacy', 'legacy', 1)`,
    [id, templateId, s.org.id, version, HASH, HASH2],
  );
  // A head trigger would add a second change here (D1 counts trigger changes).
  expect(inserted.changes).toBe(1);
  return { id, templateId, version };
}

const head = (templateId: string, scope: string) =>
  first<{ release_id: string; generation: number }>(
    db,
    "SELECT release_id, generation FROM template_release_heads WHERE template_id = ? AND org_scope = ? AND mode = 'live' AND provider = 'apple'",
    [templateId, scope],
  );

async function approvedRelease(
  s: Awaited<ReturnType<typeof seedAuthority>>,
  rel: Awaited<ReturnType<typeof legacyRelease>>,
) {
  const candidateId = s.f.ids.id();
  await run(
    db,
    `INSERT INTO template_candidates (id, template_id, org_id, mode, provider, version, candidate_hash, content_hash,
       adapter_revision, adapter_capabilities, audience_policy_revision, author_id, version_author_id, created_at)
     VALUES (?, ?, ?, 'live', 'apple', ?, ?, ?, 1, '["apple-passkit"]', 1, 'author-1', NULL, 2)`,
    [candidateId, rel.templateId, s.org.id, rel.version, HASH2, HASH],
  );
  const approvalId = s.f.ids.id();
  await run(
    db,
    'INSERT INTO template_approvals (id, candidate_id, candidate_hash, reviewer_id, created_at) VALUES (?, ?, ?, ?, 3)',
    [approvalId, candidateId, HASH2, 'reviewer-1'],
  );
  const id = s.f.ids.id();
  await run(
    db,
    `INSERT INTO template_releases (id, template_id, org_id, mode, provider, generation, version, candidate_hash,
       content_hash, adapter_revision, adapter_capabilities, audience_policy_revision, source, action,
       candidate_id, approval_id, previous_release_id, created_by, created_at)
     VALUES (?, ?, ?, 'live', 'apple', 2, ?, ?, ?, 1, '["apple-passkit"]', 1, 'approved', 'release', ?, ?, ?, ?, 4)`,
    [
      id,
      rel.templateId,
      s.org.id,
      rel.version,
      HASH2,
      HASH,
      candidateId,
      approvalId,
      rel.id,
      s.user.id,
    ],
  );
  return id;
}

describe('template_release_heads', () => {
  it('follows template_releases inserts without changing their reported changes', async () => {
    const s = await seedAuthority('heads-follow');
    const first1 = await legacyRelease(s);
    expect(await head(first1.templateId, s.org.id)).toEqual({
      release_id: first1.id,
      generation: 1,
    });
    const second = await approvedRelease(s, first1);
    expect(await head(first1.templateId, s.org.id)).toEqual({ release_id: second, generation: 2 });
    const missing = await first<{ n: number }>(
      db,
      `SELECT count(*) AS n FROM template_releases r WHERE NOT EXISTS (SELECT 1 FROM template_releases n
         WHERE n.template_id = r.template_id AND n.org_id IS r.org_id AND n.mode = r.mode AND n.provider = r.provider AND n.generation > r.generation)
       AND NOT EXISTS (SELECT 1 FROM template_release_heads h WHERE h.template_id = r.template_id
         AND h.org_scope = COALESCE(r.org_id, '') AND h.mode = r.mode AND h.provider = r.provider AND h.release_id = r.id)`,
    );
    expect(missing?.n).toBe(0);
  });

  it('is a view: every direct write, REPLACE and UPSERT is refused', async () => {
    const s = await seedAuthority('heads-guard');
    const rel1 = await legacyRelease(s);
    const rel2 = await approvedRelease(s, rel1);
    const before = await all(db, 'SELECT * FROM template_release_heads WHERE template_id = ?', [
      rel1.templateId,
    ]);
    expect(before).toEqual([
      {
        template_id: rel1.templateId,
        org_scope: s.org.id,
        mode: 'live',
        provider: 'apple',
        release_id: rel2,
        generation: 2,
      },
    ]);
    const key: SqlValue[] = [rel1.templateId, s.org.id];
    const attempts: [string, SqlValue[]][] = [
      [
        'UPDATE template_release_heads SET release_id = ?, generation = 1 WHERE template_id = ? AND org_scope = ?',
        [rel1.id, ...key],
      ],
      ['DELETE FROM template_release_heads WHERE template_id = ? AND org_scope = ?', key],
      [
        "INSERT OR REPLACE INTO template_release_heads (template_id, org_scope, mode, provider, release_id, generation) VALUES (?, ?, 'live', 'apple', ?, 1)",
        [rel1.templateId, s.org.id, rel1.id],
      ],
      [
        "INSERT INTO template_release_heads (template_id, org_scope, mode, provider, release_id, generation) VALUES (?, ?, 'live', 'apple', ?, 1) ON CONFLICT DO UPDATE SET generation = 1",
        [rel1.templateId, s.org.id, rel1.id],
      ],
    ];
    for (const [sql, params] of attempts)
      await expect(run(db, sql, params), sql.slice(0, 50)).rejects.toThrow(/view/);
    expect(
      await all(db, 'SELECT * FROM template_release_heads WHERE template_id = ?', [
        rel1.templateId,
      ]),
    ).toEqual(before);
  });

  it('template_releases cannot be replaced or upserted, and stay immutable', async () => {
    const s = await seedAuthority('heads-replace');
    const rel = await legacyRelease(s);
    const row = await first<Record<string, SqlValue>>(
      db,
      'SELECT * FROM template_releases WHERE id = ?',
      [rel.id],
    );
    const columns = Object.keys(row ?? {});
    const values = columns.map(
      (c) => (c === 'content_hash' ? HASH : (row as Record<string, SqlValue>)[c]) as SqlValue,
    );
    const marks = columns.map(() => '?').join(', ');
    for (const verb of ['INSERT OR REPLACE INTO', 'REPLACE INTO'])
      await expect(
        run(db, `${verb} template_releases (${columns.join(', ')}) VALUES (${marks})`, values),
      ).rejects.toThrow(/UNIQUE|stale|immutable/);
    await expect(
      run(
        db,
        `INSERT INTO template_releases (${columns.join(', ')}) VALUES (${marks}) ON CONFLICT(id) DO UPDATE SET content_hash = excluded.content_hash`,
        values,
      ),
    ).rejects.toThrow(/UNIQUE|stale|immutable/);
    await expect(
      run(db, 'UPDATE template_releases SET content_hash = ? WHERE id = ?', [HASH, rel.id]),
    ).rejects.toThrow(/immutable/);
    expect(
      await first<Record<string, SqlValue>>(db, 'SELECT * FROM template_releases WHERE id = ?', [
        rel.id,
      ]),
    ).toEqual(row);
    expect(await head(rel.templateId, s.org.id)).toEqual({ release_id: rel.id, generation: 1 });
  });

  it('the platform scope uses an empty org_scope', async () => {
    const s = await seedAuthority('heads-platform');
    const templateId = s.template.resolved.id;
    await run(db, "UPDATE templates SET org_id = NULL, origin = 'baked' WHERE id = ?", [
      templateId,
    ]);
    const id = s.f.ids.id();
    await run(
      db,
      `INSERT INTO template_releases (id, template_id, org_id, mode, provider, generation, version, candidate_hash,
         content_hash, adapter_revision, adapter_capabilities, audience_policy_revision, source, action, created_at)
       VALUES (?, ?, NULL, 'live', 'apple', 1, ?, ?, ?, 1, '["apple-passkit"]', 1, 'system', 'system', 1)`,
      [id, templateId, s.template.resolved.version, HASH, HASH2],
    );
    expect(await head(templateId, '')).toEqual({ release_id: id, generation: 1 });
    expect(await head(templateId, s.org.id)).toBeNull();
  });

  it('releaseHead: the org head wins, a stale release is refused, the platform head counts only for a baked template', async () => {
    const { s, route, member } = await setupGrant('heads-check');
    const rel1 = await legacyRelease(s);
    const rel2 = await approvedRelease(s, rel1);
    const attempt = async (releaseId: string, mode = 'live', who = member()) => {
      const g = grant(route, {
        purpose: 'org_mode.pass.publish',
        principal: who,
        checks: [releaseHead(rel1.templateId, mode, 'apple', releaseId)],
      });
      return g
        .commit()
        .then(() => 'ok')
        .catch((e: { code: string }) => e.code);
    };
    expect(await attempt(rel2)).toBe('ok');
    expect(await attempt(rel1.id)).toBe('TEMPLATE_RELEASE_CHANGED');
    expect(await attempt(rel2, 'test')).toBe('TEMPLATE_RELEASE_CHANGED');
    expect(await attempt(rel2, 'test', member({ mode: 'test' }))).toBe('TEMPLATE_RELEASE_CHANGED');

    // A baked template: the platform release is its head for every org that has none of its own.
    const baked = await setupGrant('heads-check-baked');
    const templateId = baked.s.template.resolved.id;
    await run(db, "UPDATE templates SET org_id = NULL, origin = 'baked' WHERE id = ?", [
      templateId,
    ]);
    const platformRelease = baked.s.f.ids.id();
    await run(
      db,
      `INSERT INTO template_releases (id, template_id, org_id, mode, provider, generation, version, candidate_hash,
         content_hash, adapter_revision, adapter_capabilities, audience_policy_revision, source, action, created_at)
       VALUES (?, ?, NULL, 'live', 'apple', 1, ?, ?, ?, 1, '["apple-passkit"]', 1, 'system', 'system', 1)`,
      [platformRelease, templateId, baked.s.template.resolved.version, HASH, HASH2],
    );
    const bakedAttempt = (releaseId: string) =>
      grant(baked.route, {
        purpose: 'org_mode.pass.publish',
        principal: baked.member(),
        checks: [releaseHead(templateId, 'live', 'apple', releaseId)],
      })
        .commit()
        .then(() => 'ok')
        .catch((e: { code: string }) => e.code);
    expect(await bakedAttempt(platformRelease)).toBe('ok');
    expect(await bakedAttempt(rel1.id)).toBe('TEMPLATE_RELEASE_CHANGED');
    // Not baked: the platform release is ignored, so it can never be the head.
    await run(db, "UPDATE templates SET origin = 'uploaded' WHERE id = ?", [templateId]);
    expect(await bakedAttempt(platformRelease)).toBe('TEMPLATE_RELEASE_CHANGED');
  });
});
