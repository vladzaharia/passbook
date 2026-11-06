import { validatePass } from '../../../passkit/index.ts';
import type { PassJson, ValidationIssue } from '../../../passkit/types.ts';
import type { PassSource } from '../../../shared/contracts/passes.ts';
import { baseUrl } from '../../platform/env.ts';
import { AppError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { listOutboxForPass } from '../delivery/repo.ts';
import { replacedBy } from './assets.ts';
import { brandingWarnings, readBranding } from './branding.ts';
import { resolveTemplate } from './builder.ts';
import { pushBudgetOf } from './change-messages.ts';
import { depsOf } from './deps.ts';
import {
  currentPassJson,
  getOrg,
  getOwnerLabel,
  getPass,
  getVersion,
  lastVoidEvent,
  listAssets,
  listBlockedUsers,
  listPassDevices,
  listVersions,
  type Pass,
} from './repo.ts';
import { memberPhotoAsset } from './repo-member-photo.ts';
import type { ScopeArg } from './scope.ts';

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
    mode: pass.mode,
    version: pass.version,
    connectionId: pass.connectionId,
    externalRef: pass.externalRef,
    syncErrorCode: pass.syncErrorCode,
    holderEmail: pass.holderEmail,
    holderState: holderStateOf(pass),
    ownerUserId: pass.ownerUserId,
    deviceCount: pass.deviceCount,
    removedAt: pass.removedAt,
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
  const original = await listAssets(ctx.env.DB, pass.id);
  const photo = await memberPhotoAsset(ctx.env.DB, pass.orgId, pass.id);
  const overrides = photo
    ? [...original.filter((a) => !/^thumbnail(?:@[23]x)?\.png$/.test(a.name)), photo]
    : original;
  const replaced = replacedBy(overrides.map((a) => a.name));
  try {
    const template = await resolveTemplate(ctx, pass.orgId, pass.templateId, pass.templateVersion);
    for (const a of template.assets) if (!replaced(a.name)) names.add(a.name);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    ctx.log.warn('pass.asset_names_unavailable', { passId: pass.id, code: error.code });
  }
  for (const a of overrides) names.add(a.name);
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

type Issue = ValidationIssue;
const issueKey = (i: Issue) => `${i.code}\u0000${i.path ?? ''}`;

/**
 * Splits warnings: the template's own (its pass.json and images, shared by every pass) and this
 * pass's (its values, overrides and the org's branding). The pass page shows only the second.
 */
async function warningsFor(ctx: ServiceContext, pass: Pass, passJson: PassJson) {
  try {
    const template = await resolveTemplate(ctx, pass.orgId, pass.templateId, pass.templateVersion);
    const identity = await depsOf(ctx.env).identities.byId(pass.identityId);
    const warn = (issues: Issue[]) => issues.filter((i) => i.severity !== 'error');
    const shared = warn(validatePass(template.passJson, template.assets, identity).issues);
    const known = new Set(shared.map(issueKey));
    const own = warn(validatePass(passJson, template.assets, identity).issues).filter(
      (i) => !known.has(issueKey(i)),
    );
    const [org, overrides] = await Promise.all([
      getOrg(ctx.env.DB, pass.orgId),
      listAssets(ctx.env.DB, pass.id),
    ]);
    const branding = brandingWarnings(
      pass.templateId,
      readBranding(org?.branding),
      overrides.map((a) => a.name),
    );
    return { pass: [...own, ...branding], template: shared };
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    ctx.log.warn('pass.warnings_unavailable', { passId: pass.id, code: error.code });
    return { pass: [], template: [] };
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
  source: PassSource | null;
  actorType: string | null;
  actorId: string | null;
  createdAt: number;
  purged: boolean;
}) {
  return {
    version: v.version,
    templateVersion: v.templateVersion,
    cause: v.cause,
    source: v.source,
    actorType: v.actorType,
    actorId: v.actorId,
    createdAt: v.createdAt,
    purged: v.purged,
  };
}

export async function detailOf(ctx: ServiceContext, pass: Pass) {
  const db = ctx.env.DB;
  const [json, devices, versions, deliveries, blockedUsers, owner, voided] = await Promise.all([
    currentPassJson(db, pass.id),
    listPassDevices(db, pass.id),
    listVersions(db, pass.id),
    listOutboxForPass(db, pass.id),
    listBlockedUsers(db, pass.id),
    pass.ownerUserId ? getOwnerLabel(db, pass.ownerUserId) : null,
    pass.status === 'voided' ? lastVoidEvent(db, pass.id) : null,
  ]);
  const passJson = parseJson(json);
  const warnings = await warningsFor(ctx, pass, passJson);
  return {
    ...toSummary(pass),
    pushBudget: await pushBudgetOf(ctx, pass.id),
    ownerName: owner?.name ?? null,
    ownerEmail: owner?.email ?? null,
    personalization: pass.personalization,
    fieldSources: pass.fieldSources,
    passJson,
    ...linksOf(ctx, pass),
    assetNames: await assetNamesOf(ctx, pass),
    blockedUsers,
    registrations: devices.length,
    devices,
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
    voided:
      pass.status === 'voided'
        ? (voided ?? { at: pass.modifiedAt, actorType: 'system', actorLabel: null })
        : null,
    warnings: warnings.pass,
    templateWarnings: warnings.template,
  };
}

export async function getPassDetail(ctx: ServiceContext, id: string, scope: ScopeArg) {
  const pass = await getPass(ctx.env.DB, id, scope);
  if (!pass) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  return detailOf(ctx, pass);
}

/** A retained version rendered like the current one. Purged versions have no stored pass.json. */
export async function getVersionDetail(
  ctx: ServiceContext,
  id: string,
  version: number,
  scope: ScopeArg,
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
  scope: ScopeArg,
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
