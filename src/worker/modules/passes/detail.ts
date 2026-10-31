import { validatePass } from '../../../passkit/index.ts';
import type { PassJson } from '../../../passkit/types.ts';
import { baseUrl } from '../../platform/env.ts';
import { AppError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { listOutboxForPass } from '../delivery/repo.ts';
import { resolveTemplate } from './builder.ts';
import { depsOf } from './deps.ts';
import {
  countRegistrations,
  currentPassJson,
  getPass,
  getVersion,
  listAssets,
  listBlockedUsers,
  listVersions,
  type Pass,
} from './repo.ts';

export function holderStateOf(pass: Pass): 'unassigned' | 'waiting' | 'owned' {
  if (pass.ownerUserId) return 'owned';
  return pass.holderEmail ? 'waiting' : 'unassigned';
}

export function toSummary(pass: Pass) {
  return {
    id: pass.id,
    orgId: pass.orgId,
    templateId: pass.templateId,
    templateVersion: pass.templateVersion,
    identityId: pass.identityId,
    serial: pass.serial,
    title: pass.displayTitle,
    subtitle: pass.displaySubtitle,
    externalId: pass.externalId,
    status: pass.status,
    version: pass.version,
    connectionId: pass.connectionId,
    externalRef: pass.externalRef,
    syncErrorCode: pass.syncErrorCode,
    holderEmail: pass.holderEmail,
    holderState: holderStateOf(pass),
    ownerUserId: pass.ownerUserId,
    modifiedAt: pass.modifiedAt,
    createdAt: pass.createdAt,
  };
}

/** Image files a pass can load: template files plus per-pass overrides. */
export async function assetNamesOf(
  ctx: ServiceContext,
  pass: Pick<Pass, 'id' | 'orgId' | 'templateId' | 'templateVersion'>,
): Promise<string[]> {
  const names = new Set<string>();
  try {
    const template = await resolveTemplate(ctx, pass.orgId, pass.templateId, pass.templateVersion);
    for (const a of template.assets) names.add(a.name);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    ctx.log.warn('pass.asset_names_unavailable', { passId: pass.id, code: error.code });
  }
  for (const a of await listAssets(ctx.env.DB, pass.id)) names.add(a.name);
  return [...names];
}

export function linksOf(ctx: ServiceContext, pass: Pass) {
  const base = baseUrl(ctx.env);
  return {
    publicUrl: `${base}/p/${pass.downloadToken}`,
    downloadUrl: `${base}/p/${pass.downloadToken}/pass.pkpass`,
    assetBaseUrl: `${base}/p/${pass.downloadToken}/assets/`,
  };
}

async function warningsFor(ctx: ServiceContext, pass: Pass, passJson: PassJson) {
  try {
    const template = await resolveTemplate(ctx, pass.orgId, pass.templateId, pass.templateVersion);
    const identity = await depsOf(ctx.env).identities.byId(pass.identityId);
    return validatePass(passJson, template.assets, identity).issues.filter(
      (i) => i.severity === 'warning',
    );
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    ctx.log.warn('pass.warnings_unavailable', { passId: pass.id, code: error.code });
    return [];
  }
}

/** The stored pass.json carries the device auth token; it never leaves the server. */
export function parseStoredPassJson(raw: string | null): PassJson {
  const json = (raw ? JSON.parse(raw) : {}) as PassJson;
  delete json.authenticationToken;
  return json;
}

const parseJson = parseStoredPassJson;

function versionSummary(v: {
  version: number;
  templateVersion: string;
  cause: string;
  actorType: string | null;
  actorId: string | null;
  createdAt: number;
  purged: boolean;
}) {
  return {
    version: v.version,
    templateVersion: v.templateVersion,
    cause: v.cause,
    actorType: v.actorType,
    actorId: v.actorId,
    createdAt: v.createdAt,
    purged: v.purged,
  };
}

export async function detailOf(ctx: ServiceContext, pass: Pass) {
  const db = ctx.env.DB;
  const [json, registrations, versions, deliveries, blockedUsers] = await Promise.all([
    currentPassJson(db, pass.id),
    countRegistrations(db, pass.id),
    listVersions(db, pass.id),
    listOutboxForPass(db, pass.id),
    listBlockedUsers(db, pass.id),
  ]);
  const passJson = parseJson(json);
  return {
    ...toSummary(pass),
    personalization: pass.personalization,
    fieldSources: pass.fieldSources,
    passJson,
    ...linksOf(ctx, pass),
    assetNames: await assetNamesOf(ctx, pass),
    blockedUsers,
    registrations,
    lastRefreshedAt: pass.lastRefreshedAt,
    versions: versions.map(versionSummary),
    deliveries: deliveries.map((d) => ({
      id: d.id,
      kind: d.kind,
      state: d.state,
      attempts: d.attempts,
      errorCode: d.errorCode,
      createdAt: d.createdAt,
      finishedAt: d.finishedAt,
    })),
    warnings: await warningsFor(ctx, pass, passJson),
  };
}

export async function getPassDetail(ctx: ServiceContext, id: string, scope: string | null) {
  const pass = await getPass(ctx.env.DB, id, scope);
  if (!pass) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  return detailOf(ctx, pass);
}

/** A retained version rendered like the current one. Purged versions have no stored pass.json. */
export async function getVersionDetail(
  ctx: ServiceContext,
  id: string,
  version: number,
  scope: string | null,
) {
  const pass = await getPass(ctx.env.DB, id, scope);
  if (!pass) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  const row = await getVersion(ctx.env.DB, id, version);
  if (!row) throw new NotFoundError('Version not found.', 'VERSION_NOT_FOUND');
  if (row.purged || !row.passJson)
    throw new AppError('VERSION_PURGED', 410, 'This version is no longer stored.');
  const detail = await detailOf(ctx, pass);
  return {
    ...detail,
    templateVersion: row.templateVersion,
    personalization: row.personalization,
    passJson: parseJson(row.passJson),
  };
}

export interface FieldChange {
  path: string;
  from: unknown;
  to: unknown;
}

function flatten(value: unknown, prefix: string, out: Map<string, unknown>): void {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else out.set(prefix, value);
}

export function diffValues(from: unknown, to: unknown): FieldChange[] {
  const a = new Map<string, unknown>();
  const b = new Map<string, unknown>();
  flatten(from, '', a);
  flatten(to, '', b);
  const changes: FieldChange[] = [];
  for (const path of new Set([...a.keys(), ...b.keys()])) {
    if (JSON.stringify(a.get(path)) !== JSON.stringify(b.get(path)))
      changes.push({ path, from: a.get(path) ?? null, to: b.get(path) ?? null });
  }
  return changes.sort((x, y) => x.path.localeCompare(y.path));
}

export async function diffVersions(
  ctx: ServiceContext,
  id: string,
  from: number,
  to: number,
  scope: string | null,
): Promise<{ changes: FieldChange[] }> {
  if (!(await getPass(ctx.env.DB, id, scope)))
    throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  const [a, b] = await Promise.all([
    getVersion(ctx.env.DB, id, from),
    getVersion(ctx.env.DB, id, to),
  ]);
  if (!a || !b) throw new NotFoundError('Version not found.', 'VERSION_NOT_FOUND');
  if (a.purged || b.purged)
    throw new AppError('VERSION_PURGED', 410, 'This version is no longer stored.');
  return { changes: diffValues(a.personalization, b.personalization) };
}
