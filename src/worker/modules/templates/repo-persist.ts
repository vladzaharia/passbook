import { grantedBatch } from '../../platform/authority.ts';
import { type Check, rowIs } from '../../platform/authority-checks.ts';
import { first, type SqlValue } from '../../platform/db.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { CommitArgs } from './persist.ts';
import { cloneSource, importMatches, sharedCloneSource } from './repo-grant-checks.ts';
import { grantRow, inGrant, templateGrant, templateGrants } from './repo-grants.ts';

const CODES = {
  lineage: 'TEMPLATE_VERSION_CONFLICT',
  stale: 'TEMPLATE_VERSION_CONFLICT',
  config: 'TEMPLATE_VERSION_CONFLICT',
};

export async function versionIsRetired(
  db: D1Database,
  templateId: string,
  version: string,
): Promise<boolean> {
  const row = await first<{ found: number }>(
    db,
    'SELECT 1 AS found FROM template_version_tombstones WHERE template_id = ? AND version = ?',
    [templateId, version],
  );
  return !!row;
}

/** Row written by the version insert as read back inside the batch, to verify immutable content. */
export interface CommittedVersion {
  version: string | null;
  build_key: string | null;
  manifest: string;
  pass_json: string;
  assets: string;
  report: string;
}

/**
 * Writes the version (and, for a new template, the template) in one grant batch: the author's
 * capability, an unrevoked membership, an active org, and the template as read. A clone also holds a
 * reader grant on its source; an import also needs its queued record unchanged.
 */
export async function writeVersion(
  ctx: ServiceContext,
  args: CommitArgs,
  key: string,
  now: number,
): Promise<{ created: boolean; stored: CommittedVersion | undefined }> {
  const { plan, body } = args;
  const [authority, ...others] = args.authorities;
  if (!authority) throw new ForbiddenError();
  const deferred = args.deferred === true;
  const checks: Check[] = [];
  if (!plan.isNew)
    checks.push(
      rowIs(
        'templates',
        plan.templateId,
        {
          ...(authority.kind === 'platform' ? { org_id: null } : {}),
          ...(args.guardActive ? { status: 'active' } : {}),
        },
        'lineage',
      ),
    );
  if (args.importSource)
    checks.push(
      importMatches({
        uploadId: args.importSource.uploadId,
        objectKey: args.importSource.objectKey,
        createdBy: args.importSource.createdBy,
        templateId: plan.templateId,
        version: body.version,
      }),
    );
  const source = args.source;
  if (source && source.orgId === null) checks.push(sharedCloneSource(source.id, source.version));
  const { writer, all } = templateGrants(
    ctx,
    [authority, ...others],
    plan.isNew ? 'create' : 'version',
    { target: plan.templateId, codes: CODES, checks, deferred },
  );
  if (source && source.orgId !== null) {
    if (source.authority?.kind !== 'session' || source.authority.orgId !== source.orgId)
      throw new ForbiddenError();
    // The reader grant proves the source is still in the reader's org and the reader still holds access.
    all.unshift(
      templateGrant(ctx, source.authority, 'clone_source', {
        codes: CODES,
        checks: [cloneSource(source.id, source.version)],
      }),
    );
  }

  if (plan.isNew)
    writer.insertSelect(
      'templates',
      [
        ...(authority.kind === 'platform' ? ['org_id'] : []),
        'id',
        'slug',
        'name',
        'description',
        'origin',
        'active_version',
        'status',
        'styles',
        'created_by',
        'created_at',
        'updated_at',
      ],
      [
        ...(authority.kind === 'platform' ? [null] : []),
        plan.templateId,
        args.slug,
        args.name,
        args.description,
        'uploaded',
        null,
        'active',
        JSON.stringify(body.styles),
        args.createdBy,
        now,
        now,
      ],
      { returning: ['id'] },
    );
  const insertIndex = plan.isNew ? 1 : 0;
  const gate = grantRow(writer);
  const content: SqlValue[] = [
    JSON.stringify(body.manifest),
    JSON.stringify(body.passJson),
    JSON.stringify(body.assets),
    JSON.stringify(body.report),
  ];
  writer.add(
    inGrant(
      writer,
      `INSERT INTO template_versions
         (template_id, version, build_key, manifest, pass_json, assets, report, created_by, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM templates WHERE id = ?)
         AND NOT EXISTS (SELECT 1 FROM template_versions WHERE template_id = ? AND version = ?)
         AND NOT EXISTS (SELECT 1 FROM template_version_tombstones WHERE template_id = ? AND version = ?)
         AND ${gate.sql}
       RETURNING version`,
      [
        plan.templateId,
        body.version,
        key,
        ...content,
        args.createdBy,
        now,
        plan.templateId,
        plan.templateId,
        body.version,
        plan.templateId,
        body.version,
        ...gate.params,
      ],
    ),
  );
  writer.add(
    inGrant(
      writer,
      `SELECT v.version, v.build_key, v.manifest, v.pass_json, v.assets, v.report
       FROM templates LEFT JOIN template_versions v ON v.template_id = templates.id AND v.version = ?
       WHERE templates.id = ?`,
      [body.version, plan.templateId],
    ),
  );
  const results = (await grantedBatch(ctx.env.DB, all)).at(-1) ?? [];
  return {
    created: (results[insertIndex]?.results.length ?? 0) > 0,
    stored: results[insertIndex + 1]?.results[0] as CommittedVersion | undefined,
  };
}
