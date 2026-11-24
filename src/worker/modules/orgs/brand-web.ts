import type { z } from 'zod';
import {
  type UpdateBrandKitSchema,
  type UploadWebLogoSchema,
  WEB_LOGO,
} from '../../../shared/contracts/brand.ts';
import type { OrgBrandingSchema, OrgDto } from '../../../shared/contracts/orgs.ts';
import type { Actor } from '../../platform/context.ts';
import { ForbiddenError, ValidationError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditActor, recordAudit } from '../audit/service.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { isPngInfo, parsePng } from '../templates/package/png.ts';
import { allowedMarks } from './brand-mark.ts';
import { webLogoKey } from './branding-files.ts';
import { collectSupersededBranding, queueWebLogoKey } from './branding-gc.ts';
import { saveOrgBrandKit } from './repo-org-writes.ts';
import { requireOrg, toDto } from './service.ts';

type Branding = z.infer<typeof OrgBrandingSchema>;

const decode = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const invalid = (message: string, code: string) => new ValidationError(message, [], code);

/** True when the PNG carries an animation control chunk (APNG). */
function isAnimated(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  while (at + 12 <= bytes.length) {
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (type === 'acTL') return true;
    if (type === 'IDAT') return false;
    at += 12 + view.getUint32(at);
  }
  return false;
}

/**
 * PNG only: the signature, every chunk's CRC, no animation, within the byte and pixel caps. SVG,
 * JPEG and the rest fail the signature; nothing else is ever stored or served.
 */
export function checkWebLogo(bytes: Uint8Array): { w: number; h: number } {
  if (bytes.length > WEB_LOGO.maxBytes)
    throw invalid('The web logo is over 512 KB.', 'IMAGE_BYTES');
  const info = parsePng(bytes);
  if (!isPngInfo(info)) throw invalid(`Web logo: ${info.error}`, 'IMAGE_INVALID');
  if (isAnimated(bytes)) throw invalid('Use a still PNG, not an animated one.', 'IMAGE_ANIMATED');
  const { width: w, height: h } = info;
  if (w > WEB_LOGO.maxWidth || h > WEB_LOGO.maxHeight)
    throw invalid(
      `Use at most ${WEB_LOGO.maxWidth} px wide and ${WEB_LOGO.maxHeight} px tall.`,
      'IMAGE_SIZE',
    );
  if (w < WEB_LOGO.minSide || h < WEB_LOGO.minSide)
    throw invalid(`Use at least ${WEB_LOGO.minSide} px on each side.`, 'IMAGE_SIZE');
  return { w, h };
}

async function commit(
  ctx: ServiceContext,
  actor: Actor,
  before: Awaited<ReturnType<typeof requireOrg>>,
  next: Branding,
  detail: Record<string, unknown>,
  authority: TenantPassWrite,
): Promise<OrgDto> {
  const saved = await saveOrgBrandKit(
    ctx,
    before,
    JSON.stringify(next),
    ctx.clock.now(),
    authority,
  );
  if (!saved) throw new ForbiddenError();
  await collectSupersededBranding(ctx, before.id, before.branding, saved.branding);
  await recordAudit(ctx, {
    ...auditActor(actor),
    orgId: before.id,
    action: 'org.update',
    targetType: 'org',
    targetId: before.id,
    detail,
  });
  return toDto(saved);
}

const current = (json: string) => JSON.parse(json) as Branding;

/** Stores the web logo content-addressed, then points the kit at it. */
export async function putWebLogo(
  ctx: ServiceContext,
  actor: Actor,
  orgId: string,
  upload: z.infer<typeof UploadWebLogoSchema>,
  authority: TenantPassWrite,
): Promise<OrgDto> {
  const found = await requireOrg(ctx, orgId);
  const before = { ...found, config_revision: upload.configRevision ?? found.config_revision };
  const bytes = decode(upload.png);
  const size = checkWebLogo(bytes);
  const sha = await sha256Hex(bytes);
  const key = webLogoKey(orgId, sha);
  // Same bytes, same key: a second upload of the logo overwrites itself with itself.
  await ctx.env.BUCKET.put(key, bytes, { httpMetadata: { contentType: 'image/png' } });
  try {
    return await commit(
      ctx,
      actor,
      before,
      { ...current(before.branding), web: { sha, ...size } },
      { changes: { 'branding.web': { sha, ...size } } },
      authority,
    );
  } catch (error) {
    // Unreferenced now; the sweep deletes it unless an org's kit still uses it.
    await queueWebLogoKey(ctx, orgId, key);
    throw error;
  }
}

export async function deleteWebLogo(
  ctx: ServiceContext,
  actor: Actor,
  orgId: string,
  configRevision: number | undefined,
  authority: TenantPassWrite,
): Promise<OrgDto> {
  const found = await requireOrg(ctx, orgId);
  const before = { ...found, config_revision: configRevision ?? found.config_revision };
  const { web: _gone, ...rest } = current(before.branding);
  return commit(ctx, actor, before, rest, { changes: { 'branding.web': null } }, authority);
}

/**
 * Accent and mark level. The plan must allow the mark. A later plan change never rewrites it: holders see
 * `effectiveMark(stored, allowed)`, so a stored mark the plan no longer allows is harmless.
 */
export async function updateBrandKit(
  ctx: ServiceContext,
  actor: Actor,
  orgId: string,
  input: z.infer<typeof UpdateBrandKitSchema>,
  authority: TenantPassWrite,
): Promise<OrgDto> {
  const found = await requireOrg(ctx, orgId);
  const before = { ...found, config_revision: input.configRevision ?? found.config_revision };
  if (input.mark && !(await allowedMarks(ctx, orgId)).includes(input.mark))
    throw new ForbiddenError('This plan does not include that setting.', 'BRAND_MARK_NOT_ALLOWED');
  const { accent: oldAccent, ...rest } = current(before.branding);
  const accent = input.accent === undefined ? oldAccent : (input.accent ?? undefined);
  const next: Branding = {
    ...rest,
    ...(accent ? { accent } : {}),
    ...(input.mark ? { mark: input.mark } : {}),
  };
  const changes: Record<string, unknown> = {};
  if (input.accent !== undefined) changes['branding.accent'] = input.accent;
  if (input.mark) changes['branding.mark'] = input.mark;
  return commit(ctx, actor, before, next, { changes }, authority);
}
