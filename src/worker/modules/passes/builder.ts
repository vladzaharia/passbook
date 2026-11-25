import { PassBuildError } from '../../../passkit/build.ts';
import {
  buildPass,
  buildPassPreview,
  crc32,
  packagePassBytes,
  signPass,
} from '../../../passkit/index.ts';
import { sha1Hex } from '../../../passkit/sign/index.ts';
import type { ResolvedTemplate, TemplateRegistry } from '../../../passkit/template/registry.ts';
import type {
  AssetEntry,
  PassJson,
  Personalization,
  ValidationIssue,
} from '../../../passkit/types.ts';
import { PREVIEW_PASS_IDENTITY } from '../../../shared/copy/developer.ts';
import { type FieldIssue, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { isPreviewOnlyOrg } from '../developer/fence.ts';
import type { IdentityRow } from '../identities/repo.ts';
import { brandingFiles } from '../orgs/branding-files.ts';
import { parseAssetName, replacedBy } from './assets.ts';
import { appliedBranding, readBranding, type TenantBranding } from './branding.ts';
import { type PrefetchedAuthSeal, plainAuthToken } from './build-auth-token.ts';
import { type BuildInputs, readBuildInputs } from './build-reads.ts';
import { artifactOf, editPass, tenantOf } from './builder-finish.ts';
import { buildIssue } from './builder-issues.ts';
import { backContactsFor } from './contacts.ts';
import { depsOf } from './deps.ts';
import type { Removal } from './remove-build.ts';
import type { PassStatus } from './repo.ts';
import type { AssetRow } from './repo-history-assets.ts';

export { displayOf } from './builder-finish.ts';

export interface BuildRequest {
  orgId: string;
  orgName: string;
  personal: boolean;
  passId: string;
  serial: string;
  /** The `auth_token` column value (a MAC), or `{ fresh }` for a token just made and not yet stored. */
  authToken: string | { fresh: string };
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
  changeMessages?: { previous: PassJson | null; notify: boolean; text?: string };
  /** Strips every changeMessage: the update reaches devices without a notification. */
  silent?: boolean;
  /** Set while the pass is removed from Wallet: every build stays the stripped, voided version. */
  removal?: Removal;
  /** Excludes the current holder's uploaded assets and member photo from this build. */
  omitPassAssets?: boolean;
  /** Reads the caller already made in a batch; each is used only when it still applies. */
  prefetched?: {
    identityRow: IdentityRow | null;
    /** Inputs read for `templateId`; ignored when the template resolves to another id. */
    inputs: BuildInputs;
    /** The sealed copy of `authToken`, read with them; used only while it still names `authToken`. */
    authSeal?: PrefetchedAuthSeal;
  };
}

export interface Artifact {
  /** The signed .pkpass; for a developer org the pass JSON, which no wallet can open (`previewOnly`). */
  bytes: Uint8Array;
  /** A developer org's pass: built and stored as a preview, never signed. */
  previewOnly: boolean;
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
      override: true,
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
  // A developer org's pass is never signed: its identity is a placeholder and no key is ever read.
  const row = req.prefetched?.identityRow;
  const identity = (await isPreviewOnlyOrg(ctx.env.DB, req.orgId))
    ? null
    : row && row.id === req.identityId && deps.identities.byRow
      ? await deps.identities.byRow(row)
      : await deps.identities.byId(req.identityId);
  const branding = appliedBranding(readBranding(req.branding), resolved.manifest);
  const [{ overrides: originalOverrides, photo, artHashes }, contacts, authToken] =
    await Promise.all([
      req.prefetched && resolved.id === req.templateId && !req.omitPassAssets
        ? req.prefetched.inputs
        : readBuildInputs(ctx.env.DB, req, resolved.id),
      backContactsFor(ctx, req.orgId, req.branding),
      plainAuthToken(ctx.env, req),
    ]);
  const passOverrides = photo
    ? [...originalOverrides.filter((a) => parseAssetName(a.name).slot !== 'thumbnail'), photo]
    : originalOverrides;
  const tenant = tenantOf(req, resolved, branding, contacts);
  const { template, registry } = await withOverrides(
    { ...resolved, passJson: tenant.passJson },
    deps.registry,
    ctx.env.BUCKET,
    await brandedOverrides(ctx.env.BUCKET, req.orgId, passOverrides, branding),
  );
  const now = new Date(ctx.clock.now());
  try {
    if (identity === null) {
      // A developer org: the same build, stopped before the signature. The stored object is the pass JSON.
      const built = await buildPassPreview({
        template,
        registry,
        input: req.personalization,
        server: {
          serial: req.serial,
          authToken,
          webServiceURL: req.webServiceUrl,
          organizationName: tenant.issuer,
          identity: PREVIEW_PASS_IDENTITY,
          ...(req.scanCode ? { scanCode: req.scanCode } : {}),
        },
        behaviors: deps.behaviors,
        now,
      });
      editPass(req, built.passJson);
      const { authenticationToken: _token, ...shown } = built.passJson;
      return await artifactOf({
        bytes: new TextEncoder().encode(JSON.stringify(shown)),
        previewOnly: true,
        built,
        req,
        resolved,
        template,
        branding,
        passOverrides,
        artHashes,
      });
    }
    const built = await buildPass({
      template,
      registry,
      input: req.personalization,
      server: {
        serial: req.serial,
        authToken,
        webServiceURL: req.webServiceUrl,
        organizationName: tenant.issuer,
        identity,
        ...(req.scanCode ? { scanCode: req.scanCode } : {}),
      },
      signing: identity.material,
      behaviors: deps.behaviors,
      now,
    });
    const resign = editPass(req, built.passJson);
    let { signed } = built;
    if (resign) {
      const {
        'pass.json': _pass,
        'manifest.json': _manifest,
        signature: _sig,
        ...assets
      } = signed.files;
      signed = await signPass(built.passJson, assets, identity.material, { now });
    }
    return await artifactOf({
      bytes: packagePassBytes(signed),
      previewOnly: false,
      built,
      req,
      resolved,
      template,
      branding,
      passOverrides,
      artHashes,
    });
  } catch (error) {
    if (error instanceof PassBuildError) {
      const issues: FieldIssue[] = error.report.issues
        .filter((i) => i.severity === 'error')
        .map(buildIssue);
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
