import type { z } from 'zod';
import type { PassJson } from '../../../passkit/types.ts';
import type { CodeFormatSchema, ScanRole } from '../../../shared/contracts/scan.ts';
import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import { scanOf } from '../../../shared/scan-defaults.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { isNotFound, resolveTemplate } from '../passes/builder.ts';
import { planCounts } from './counts.ts';
import type { ScanActor } from './guard.ts';
import { undoWindowMinutes } from './outcome.ts';
import { orgNameStmt, staffListStmt, userNameStmt } from './repo-session.ts';
import { styleOf } from './resolve.ts';

type Format = z.infer<typeof CodeFormatSchema>;

const FORMATS: Record<string, Format> = {
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

function stateOf(ctx: ServiceContext, actor: ScanActor): ScanSession['state'] {
  const now = ctx.clock.now();
  if (
    actor.scanner?.deviceRole === 'scan' &&
    actor.principal === 'scanner' &&
    actor.settings.staffSignIn &&
    actor.role === null
  )
    return 'staff_required';
  if (
    actor.scanner?.deviceRole === 'scan' &&
    actor.templateIds.length === 0 &&
    !actor.settings.acceptAllTemplates
  )
    return 'unassigned';
  if (actor.event && now < actor.event.opensAt) return 'not_open';
  if (actor.event && now > actor.event.closesAt) return 'closed';
  return 'ready';
}

async function templatesOf(
  ctx: ServiceContext,
  actor: ScanActor,
): Promise<ScanSession['templates']> {
  const out: ScanSession['templates'] = [];
  for (const id of actor.templateIds.slice(0, 20)) {
    try {
      const t = await resolveTemplate(ctx, actor.orgId, id);
      out.push({
        id,
        name: t.manifest.name,
        style: styleOf(t.passJson),
        formats: formatsOf(t.passJson),
        actions: scanOf(t.manifest).actions.map((a) => ({
          id: a.id,
          label: a.label,
          kind: a.kind,
        })),
      });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  return out;
}

export async function buildSession(
  ctx: ServiceContext,
  actor: ScanActor,
  dayStart?: number,
): Promise<ScanSession> {
  if (actor.scanner && actor.scanner.deviceRole !== 'scan')
    actor = { ...actor, event: null, templateIds: [], staff: null };
  const db = ctx.env.DB;
  const counts = planCounts(ctx, actor, dayStart);
  const listStaff =
    actor.scanner?.deviceRole === 'scan' &&
    actor.principal === 'scanner' &&
    actor.settings.staffSignIn;
  const [results, templates, undoWindow] = await Promise.all([
    db.batch([
      orgNameStmt(db, actor.orgId),
      actor.principal === 'admin'
        ? userNameStmt(db, actor.actor.id)
        : staffListStmt(db, actor.orgId),
      ...counts.stmts,
    ]),
    templatesOf(ctx, actor),
    undoWindowMinutes(ctx),
  ]);
  const orgName = (results[0]?.results?.[0] as { name: string } | undefined)?.name ?? '';
  const read = await counts.read(results.slice(2));
  const formats = actor.settings.acceptAllTemplates
    ? Object.values(FORMATS)
    : [...new Set(templates.flatMap((t) => t.formats))];
  const staffRows = (results[1]?.results ?? []) as { id: string; name: string; role: ScanRole }[];
  const event = actor.event;
  const user = results[1]?.results?.[0] as
    | { name: string | null; primary_email: string }
    | undefined;
  return {
    principal: actor.principal,
    state: stateOf(ctx, actor),
    scanner: actor.scanner
      ? {
          id: actor.scanner.id,
          name: actor.scanner.name,
          kind: actor.scanner.kind,
          deviceRole: actor.scanner.deviceRole,
          mode: actor.mode,
          orgId: actor.orgId,
          orgName,
          timeZone: actor.timeZone,
          settings: actor.settings,
        }
      : null,
    admin:
      actor.principal === 'admin'
        ? {
            name: user?.name ?? user?.primary_email ?? 'Admin',
            orgs: [{ id: actor.orgId, name: orgName }],
          }
        : null,
    event: event
      ? {
          id: event.id,
          name: event.name,
          opensAt: event.opensAt,
          closesAt: event.closesAt,
          timeZone: event.timeZone,
          reentry: event.reentry,
          note: event.note,
        }
      : null,
    templates,
    formats,
    staff: actor.staff,
    staffList: listStaff ? staffRows : null,
    approvals: read.approvals,
    csrfToken: actor.scanner?.csrfSecret ?? null,
    undoWindowMinutes: undoWindow,
    counts: read.counts,
  };
}
