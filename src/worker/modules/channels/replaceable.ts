import { barcodeIsScanCode } from '../../../passkit/template/scan-code-barcode.ts';
import type { TemplateManifest } from '../../../passkit/types.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import * as repo from './repo.ts';
import { manifestOf } from './repo-replace.ts';

/** Whether a manifest's barcode is the scan code, so a New code can replace what it encodes. */
export function manifestReplaceable(manifest: string | null): boolean {
  if (manifest === null) return false;
  try {
    return barcodeIsScanCode(JSON.parse(manifest) as TemplateManifest);
  } catch {
    return false;
  }
}

/** Checked against the version the org's release serves in this mode. */
export async function templateReplaceable(
  ctx: ServiceContext,
  template: repo.TemplateRef,
  mode: Mode,
): Promise<boolean> {
  const version =
    (await repo.releasedVersion(ctx.env.DB, template.id, template.orgId, mode)) ??
    template.activeVersion;
  return manifestReplaceable(await manifestOf(ctx.env.DB, template.id, version));
}

/** A pass is checked against its own pinned version. */
export async function passReplaceable(
  ctx: ServiceContext,
  pass: { templateId: string; templateVersion: string },
): Promise<boolean> {
  return manifestReplaceable(await manifestOf(ctx.env.DB, pass.templateId, pass.templateVersion));
}
