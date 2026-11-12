import type { z } from 'zod';
import type { ResolvedTemplate } from '../../../passkit/template/registry.ts';
import type { PassJson } from '../../../passkit/types.ts';
import type { CodeFormatSchema } from '../../../shared/contracts/scan.ts';
import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import { scanOf } from '../../../shared/scan-defaults.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { isNotFound, resolveTemplate } from '../passes/builder.ts';
import type { ScanActor } from './actor.ts';
import {
  captureTemplateStamps,
  type SessionLegacyStamp,
  type SessionReleaseStamp,
} from './repo-scope-releases.ts';
import { styleOf } from './resolve.ts';

type Format = z.infer<typeof CodeFormatSchema>;

interface ScopedTemplates {
  templates: ScanSession['templates'];
  releases: SessionReleaseStamp[];
  legacy: SessionLegacyStamp[];
}

export const FORMATS: Record<string, Format> = {
  PKBarcodeFormatQR: 'qr',
  PKBarcodeFormatPDF417: 'pdf417',
  PKBarcodeFormatAztec: 'aztec',
  PKBarcodeFormatCode128: 'code128',
  PKBarcodeFormatCode39: 'code39',
  PKBarcodeFormatCodabar: 'codabar',
  PKBarcodeFormatEAN13: 'ean13',
  PKBarcodeFormatI2of5: 'itf',
};

/** The formats a template's pass can carry; a pass with none is still scanned by its code in a QR. */
function formatsOf(passJson: PassJson): Format[] {
  const record = passJson as { barcodes?: { format?: string }[]; barcode?: { format?: string } };
  const all = [...(record.barcodes ?? []), ...(record.barcode ? [record.barcode] : [])];
  const found = [
    ...new Set(all.map((b) => FORMATS[b.format ?? '']).filter((f): f is Format => !!f)),
  ];
  return found.length > 0 ? found : ['qr'];
}

function templateView(id: string, template: ResolvedTemplate): ScanSession['templates'][number] {
  return {
    id,
    name: template.manifest.name,
    style: styleOf(template.passJson),
    formats: formatsOf(template.passJson),
    actions: scanOf(template.manifest).actions.map((action) => ({
      id: action.id,
      label: action.label,
      kind: action.kind,
    })),
  };
}

/** More than one pinned version has no single authoritative title, style, or action policy. */
async function legacyTemplateView(
  ctx: ServiceContext,
  actor: ScanActor,
  id: string,
  versions: readonly string[],
): Promise<ScanSession['templates'][number] | null> {
  const only = versions[0];
  if (versions.length === 1 && only !== undefined) {
    const view = templateView(id, await resolveTemplate(ctx, actor.orgId, id, only));
    return view.actions.length > 0 && view.formats.length > 0 ? view : null;
  }
  let commonFormats: Format[] | null = null;
  let commonActions: Map<string, ScanSession['templates'][number]['actions'][number]> | null = null;
  for (const version of versions) {
    const template = await resolveTemplate(ctx, actor.orgId, id, version);
    const scan = scanOf(template.manifest);
    const formats = formatsOf(template.passJson);
    commonFormats =
      commonFormats === null ? formats : commonFormats.filter((format) => formats.includes(format));
    const actions = new Map<string, ScanSession['templates'][number]['actions'][number]>();
    for (const action of scan.actions) {
      // Exact policy equality is intentionally conservative when action labels hide different rights.
      const signature = JSON.stringify({
        action,
        inputSchema: action.input
          ? (template.manifest.inputs.properties?.[action.input] ?? null)
          : null,
        behaviors: template.manifest.behaviors ?? null,
        window: scan.window ?? null,
        flags: scan.flags ?? null,
        access: scan.access ?? null,
      });
      actions.set(signature, { id: action.id, label: action.label, kind: action.kind });
    }
    if (commonActions === null) commonActions = actions;
    else {
      for (const signature of commonActions.keys()) {
        if (!actions.has(signature)) commonActions.delete(signature);
      }
    }
    if (commonFormats.length === 0 || commonActions.size === 0) return null;
  }
  if (!commonFormats?.length || !commonActions?.size) return null;
  return {
    id,
    name: 'Pass',
    style: 'generic',
    formats: commonFormats.sort(),
    actions: [...commonActions.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}
export async function templatesOf(
  ctx: ServiceContext,
  actor: ScanActor,
): Promise<ScopedTemplates | null> {
  if (actor.templateIds.length > 20) return null;
  const templateIds = actor.templateIds;
  const captured = await captureTemplateStamps(ctx.env.DB, actor.orgId, actor.mode, templateIds);
  if (!captured) return null;
  const releases = new Map(captured.releases.map((stamp) => [stamp.templateId, stamp] as const));
  const legacy = new Map(captured.legacy.map((stamp) => [stamp.templateId, stamp] as const));
  const out: ScanSession['templates'] = [];
  for (const id of templateIds) {
    try {
      const release = releases.get(id);
      const pinned = legacy.get(id);
      if (!release) {
        const versions = pinned?.versions ?? [];
        if (versions.length === 0 || versions.some((version) => version.length === 0)) return null;
        const view = await legacyTemplateView(ctx, actor, id, versions);
        if (!view) return null;
        out.push(view);
        continue;
      }
      if (pinned || release.version.length === 0) return null;
      const template = await resolveTemplate(ctx, actor.orgId, id, release.version);
      out.push(templateView(id, template));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }
  return { templates: out, releases: captured.releases, legacy: captured.legacy };
}
