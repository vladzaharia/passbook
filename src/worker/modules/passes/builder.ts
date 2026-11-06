import { PassBuildError } from '../../../passkit/build.ts';
import { buildPass, crc32, packagePassBytes, signPass } from '../../../passkit/index.ts';
import { sha1Hex } from '../../../passkit/sign/index.ts';
import { evaluate } from '../../../passkit/template/expr.ts';
import type { ResolvedTemplate, TemplateRegistry } from '../../../passkit/template/registry.ts';
import type {
  AssetEntry,
  PassJson,
  Personalization,
  ValidationIssue,
} from '../../../passkit/types.ts';
import { type FieldIssue, NotFoundError, ValidationError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { brandingFiles } from '../orgs/branding-files.ts';
import { parseAssetName, replacedBy } from './assets.ts';
import { brandingWarnings, readBranding, type TenantBranding, tenantPassJson } from './branding.ts';
import { applyChangeMessages, stripChangeMessages } from './change-messages.ts';
import { backContactsFor, withBackContacts } from './contacts.ts';
import { depsOf } from './deps.ts';
import { applyRemoval, type Removal } from './remove-build.ts';
import { type AssetRow, listAssets, type PassStatus } from './repo.ts';
import { memberPhotoAsset } from './repo-member-photo.ts';
import { barcodeHashOf, lookupHashOf, lookupValueOf } from './scan-code.ts';

export interface BuildRequest {
  orgId: string;
  orgName: string;
  passId: string;
  serial: string;
  authToken: string;
  /** Frozen at creation: rebuilds must not change the pass identity (audit B7). */
  webServiceUrl: string;
  identityId: string;
  templateId: string;
  templateVersion?: string;
  personalization: Personalization;
  status: PassStatus;
  /** Bound as `{{pass.scanCode}}`. */
  scanCode?: string;
  /** Raw `orgs.branding`; colours, logo and icon replace the template's (readBranding). */
  branding?: unknown;
  /**
   * An editor's save: without `notify` no field carries a changeMessage; with it only fields whose
   * value differs from `previous` do. Omitted (syncs, upgrades), the template's messages stay.
   */
  changeMessages?: { previous: PassJson | null; notify: boolean };
  /** Strips every changeMessage: the update reaches devices without a notification. */
  silent?: boolean;
  /** Set while the pass is removed from Wallet: every build stays the stripped, voided version. */
  removal?: Removal;
}

export interface Artifact {
  bytes: Uint8Array;
  sha256: string;
  passJson: PassJson;
  template: ResolvedTemplate;
  title: string | null;
  subtitle: string | null;
  /** Pass.json plus asset digests; equal hashes mean identical content. */
  contentHash: string;
  /** SHA-256 hex of the primary barcode message; null without a barcode. */
  barcodeHash: string | null;
  /** SHA-256 hex of the normalized `scan.lookup` input; null without `scan.lookup` or a value. */
  lookupHash: string | null;
  warnings: ValidationIssue[];
}

export const isNotFound = (error: unknown): boolean =>
  error instanceof NotFoundError || (error as { status?: number } | null)?.status === 404;

export async function resolveTemplate(
  ctx: ServiceContext,
  orgId: string,
  templateId: string,
  version?: string,
): Promise<ResolvedTemplate> {
  let template: ResolvedTemplate;
  try {
    template = await depsOf(ctx.env).registry.resolve(templateId, version);
  } catch (error) {
    // Only a missing template is a 404; infrastructure errors must surface and retry.
    if (!isNotFound(error)) throw error;
    ctx.log.warn('pass.template_unresolved', { orgId, templateId, error });
    throw new NotFoundError('Template not found.', 'TEMPLATE_NOT_FOUND');
  }
  // Platform templates (orgId null) are usable by every org; org templates only by their own.
  if (template.orgId !== null && template.orgId !== orgId)
    throw new NotFoundError('Template not found.', 'TEMPLATE_NOT_FOUND');
  return template;
}

async function withOverrides(
  template: ResolvedTemplate,
  registry: TemplateRegistry,
  bucket: R2Bucket,
  overrides: AssetRow[],
): Promise<{ template: ResolvedTemplate; registry: TemplateRegistry }> {
  if (overrides.length === 0) return { template, registry };
  const replaced = replacedBy(overrides.map((a) => a.name));
  const entries: AssetEntry[] = [];
  for (const a of overrides) {
    const { slot, scale } = parseAssetName(a.name);
    entries.push({
      name: a.name,
      slot,
      scale,
      size: a.size,
      sha1: a.sha1,
      crc32: a.crc32 ?? (await legacyCrc(bucket, a)),
      ...(a.width ? { width: a.width } : {}),
      ...(a.height ? { height: a.height } : {}),
      source: { kind: 'r2', key: a.r2Key },
    });
  }
  const byName = new Map(overrides.map((a) => [a.name, a.r2Key]));
  return {
    template: {
      ...template,
      assets: [...template.assets.filter((a) => !replaced(a.name)), ...entries],
    },
    registry: {
      list: (query) => registry.list(query),
      resolve: (id, version) => registry.resolve(id, version),
      async openAsset(t, name) {
        const key = byName.get(name);
        if (!key) return registry.openAsset(t, name);
        const object = await bucket.get(key);
        if (!object) throw new NotFoundError(`Image ${name} is missing.`, 'ASSET_NOT_FOUND');
        return object.body;
      },
    },
  };
}

/** Rows uploaded before the crc32 column existed. */
async function legacyCrc(bucket: R2Bucket, a: AssetRow): Promise<number> {
  const object = await bucket.get(a.r2Key);
  if (!object) throw new NotFoundError(`Image ${a.name} is missing.`, 'ASSET_NOT_FOUND');
  return crc32(new Uint8Array(await object.arrayBuffer()));
}

export function displayOf(
  template: ResolvedTemplate,
  input: Personalization,
): { title: string | null; subtitle: string | null } {
  const scope = { input, lookups: template.manifest.lookups ?? {} };
  const text = (expr: Parameters<typeof evaluate>[0] | undefined): string | null => {
    if (expr === undefined) return null;
    const value = evaluate(expr, scope);
    return value === undefined || value === null || value === ''
      ? null
      : String(value).slice(0, 200);
  };
  return {
    title: text(template.manifest.display.title),
    subtitle: text(template.manifest.display.subtitle),
  };
}

/** The org's uploaded logo and icon as asset rows (digests read from the stored PNGs). */
async function brandingRows(
  bucket: R2Bucket,
  orgId: string,
  branding: TenantBranding,
): Promise<AssetRow[]> {
  const files = await brandingFiles(bucket, orgId, branding.images);
  return Promise.all(
    files.map(async (f) => {
      const object = await bucket.get(f.r2Key);
      if (!object) throw new NotFoundError(`Image ${f.name} is missing.`, 'ASSET_NOT_FOUND');
      const bytes = new Uint8Array(await object.arrayBuffer());
      return {
        name: f.name,
        r2Key: f.r2Key,
        sha1: await sha1Hex(bytes),
        size: bytes.length,
        width: f.width,
        height: f.height,
        crc32: crc32(bytes),
        createdAt: 0,
      };
    }),
  );
}

/** Org branding fills the slots a per-pass override leaves; overrides win. */
async function brandedOverrides(
  bucket: R2Bucket,
  orgId: string,
  overrides: AssetRow[],
  branding: TenantBranding,
): Promise<AssetRow[]> {
  if (branding.images.length === 0) return overrides;
  const taken = replacedBy(overrides.map((a) => a.name));
  const rows = await brandingRows(bucket, orgId, branding);
  return [...overrides, ...rows.filter((b) => !taken(b.name))];
}

/** Resolves, builds, signs and packages one pass. Does not touch R2 or D1 state. */
export async function buildArtifact(ctx: ServiceContext, req: BuildRequest): Promise<Artifact> {
  const deps = depsOf(ctx.env);
  const resolved = await resolveTemplate(ctx, req.orgId, req.templateId, req.templateVersion);
  const identity = await deps.identities.byId(req.identityId);
  const branding = readBranding(req.branding);
  const [originalOverrides, contacts, photo] = await Promise.all([
    listAssets(ctx.env.DB, req.passId),
    backContactsFor(ctx, req.orgId, req.branding),
    memberPhotoAsset(ctx.env.DB, req.orgId, req.passId),
  ]);
  const passOverrides = photo
    ? [...originalOverrides.filter((a) => parseAssetName(a.name).slot !== 'thumbnail'), photo]
    : originalOverrides;
  const tenant = withBackContacts(
    tenantPassJson(resolved.passJson, req.orgName, branding),
    contacts,
  );
  const { template, registry } = await withOverrides(
    { ...resolved, passJson: tenant },
    deps.registry,
    ctx.env.BUCKET,
    await brandedOverrides(ctx.env.BUCKET, req.orgId, passOverrides, branding),
  );
  const now = new Date(ctx.clock.now());
  try {
    const built = await buildPass({
      template,
      registry,
      input: req.personalization,
      server: {
        serial: req.serial,
        authToken: req.authToken,
        webServiceURL: req.webServiceUrl,
        organizationName: req.orgName,
        identity,
        ...(req.scanCode ? { scanCode: req.scanCode } : {}),
      },
      signing: identity.material,
      behaviors: deps.behaviors,
      now,
    });
    let { signed } = built;
    let resign = false;
    if (req.status === 'voided' && built.passJson.voided !== true) {
      built.passJson.voided = true;
      resign = true;
    }
    if (req.changeMessages) {
      const { previous, notify } = req.changeMessages;
      resign = applyChangeMessages(built.passJson, previous, notify) || resign;
    }
    if (req.silent) resign = stripChangeMessages(built.passJson) || resign;
    if (req.removal) {
      applyRemoval(built.passJson, req.removal);
      resign = true;
    }
    if (resign) {
      const {
        'pass.json': _pass,
        'manifest.json': _manifest,
        signature: _sig,
        ...assets
      } = signed.files;
      signed = await signPass(built.passJson, assets, identity.material, { now });
    }
    const bytes = packagePassBytes(signed);
    const display = displayOf(template, req.personalization);
    const lookupInput = resolved.manifest.scan?.lookup?.input;
    const lookupValue = lookupInput ? lookupValueOf(req.personalization, lookupInput) : null;
    return {
      bytes,
      sha256: await sha256Hex(bytes),
      passJson: built.passJson,
      template: resolved,
      title: display.title,
      subtitle: display.subtitle,
      contentHash: built.contentHash,
      barcodeHash: await barcodeHashOf(built.passJson),
      lookupHash: lookupValue === null ? null : await lookupHashOf(lookupValue),
      warnings: [
        ...built.report.issues.filter((i) => i.severity !== 'error'),
        ...brandingWarnings(
          req.templateId,
          branding,
          passOverrides.map((a) => a.name),
        ),
      ],
    };
  } catch (error) {
    if (error instanceof PassBuildError) {
      const issues: FieldIssue[] = error.report.issues
        .filter((i) => i.severity === 'error')
        .map((i) => ({ path: i.path ?? '', message: i.message, code: i.code }));
      throw new ValidationError(
        error.code === 'INVALID_INPUT'
          ? 'The pass input is invalid.'
          : 'The pass failed validation.',
        issues,
        error.code === 'INVALID_INPUT' ? 'PASS_INPUT_INVALID' : 'PASS_INVALID',
      );
    }
    throw error;
  }
}
