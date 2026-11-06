import type { z } from 'zod';
import type { TemplateManifest } from '../../../passkit/types.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import {
  type CreateScannerSchema,
  type ScannerListQuerySchema,
  type ScannerModeSchema,
  ScannerSettingsSchema,
  type UpdateScannerSchema,
} from '../../../shared/contracts/index.ts';
import { batch, classifyD1Error } from '../../platform/db.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditStmt } from '../audit/repo.ts';
import { orgIsActive } from '../orgs/repo.ts';
import { createPassRow } from '../passes/service.ts';
import { DEFAULT_SETTINGS, dayStartMs, parseSettings, scannerDto } from './dto-console.ts';
import { createPairing } from './pairing.ts';
import { TERMINAL_TTL_MS } from './pairing-token.ts';
import {
  addTemplatesStmts,
  type ConsoleScannerRow,
  countToday,
  eventModeOf,
  firstTemplateManifest,
  getConsoleScanner,
  insertScannerStmt,
  listConsoleScanners,
  replaceTemplatesStmts,
  revokeStmt,
  setModeStmt,
  updateScannerStmt,
} from './repo-scanners.ts';
import { countOrgTemplates, eventTemplateIds } from './repo-scope.ts';

type Accepts = z.infer<typeof CreateScannerSchema>['accepts'];

const modeMismatch = () =>
  new ValidationError(
    'This event is in a different mode than the scanner.',
    [],
    'SCAN_MODE_MISMATCH',
  );

async function withToday(ctx: ServiceContext, rows: ConsoleScannerRow[]) {
  const now = ctx.clock.now();
  const counts = await countToday(
    ctx.env.DB,
    rows
      .filter((r) => r.kind !== 'display')
      .map((r) => ({ id: r.id, since: dayStartMs(r.timeZone, now) })),
  );
  return rows.map((r) => scannerDto(r, now, counts.get(r.id) ?? 0));
}

export async function listScanners(
  ctx: ServiceContext,
  mode: Mode,
  query: z.infer<typeof ScannerListQuerySchema>,
) {
  const rows = await listConsoleScanners(ctx.env.DB, { ...query, mode, limit: query.limit + 1 });
  const page = rows.slice(0, query.limit);
  return {
    items: await withToday(ctx, page),
    nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

/** A scanner by id, or 404. The console may open a scanner in either mode. */
export async function loadScanner(ctx: ServiceContext, id: string): Promise<ConsoleScannerRow> {
  const row = await getConsoleScanner(ctx.env.DB, id);
  if (!row) throw new NotFoundError('Scanner not found.', 'SCANNER_NOT_FOUND');
  return row;
}

export async function scannerView(ctx: ServiceContext, id: string) {
  const [dto] = await withToday(ctx, [await loadScanner(ctx, id)]);
  if (!dto) throw new NotFoundError('Scanner not found.', 'SCANNER_NOT_FOUND');
  return dto;
}

/** Same org, same mode, and for templates a live template of the org: anything else is a 404. */
async function checkAccepts(ctx: ServiceContext, orgId: string, mode: Mode, accepts: Accepts) {
  const db = ctx.env.DB;
  if ('eventId' in accepts) {
    const event = await eventModeOf(db, orgId, accepts.eventId);
    if (!event || event.archived_at !== null)
      throw new NotFoundError('Event not found.', 'EVENT_NOT_FOUND');
    if (event.mode !== mode) throw modeMismatch();
    return { eventId: accepts.eventId, templateIds: [] as string[] };
  }
  const templateIds = [...new Set(accepts.templateIds)];
  if ((await countOrgTemplates(db, orgId, templateIds)) !== templateIds.length)
    throw new NotFoundError('Template not found.', 'TEMPLATE_NOT_FOUND');
  return { eventId: null, templateIds };
}

function nameTaken(error: unknown): never {
  const info = classifyD1Error(error);
  if (info?.kind === 'unique' && /scanners\.name|scanners_org_name/.test(info.detail))
    throw new ConflictError('Another scanner already has that name.', 'SCANNER_NAME_TAKEN');
  throw error;
}

export async function createScanner(
  ctx: ServiceContext,
  userId: string,
  mode: Mode,
  input: z.infer<typeof CreateScannerSchema>,
  origin: string,
) {
  const db = ctx.env.DB;
  if (!(await orgIsActive(db, input.orgId)))
    throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  const accepts = await checkAccepts(ctx, input.orgId, mode, input.accepts);
  const settings = ScannerSettingsSchema.parse({ ...DEFAULT_SETTINGS, ...input.settings });
  const now = ctx.clock.now();
  const id = ctx.ids.id();
  try {
    await batch(db, [
      insertScannerStmt(db, {
        id,
        orgId: input.orgId,
        mode,
        kind: input.kind,
        name: input.name,
        eventId: accepts.eventId,
        settings: JSON.stringify(settings),
        timeZone: input.timeZone,
        expiresAt: input.kind === 'terminal' ? now + TERMINAL_TTL_MS : null,
        createdBy: userId,
        now,
      }),
      ...addTemplatesStmts(db, id, accepts.templateIds),
      auditStmt(db, ctx, {
        orgId: input.orgId,
        actorType: 'user',
        actorId: userId,
        action: 'scanner.create',
        targetType: 'scanner',
        targetId: id,
        detail: { kind: input.kind, mode, accepts: accepts.eventId ? 'event' : 'templates' },
      }),
    ]);
  } catch (error) {
    nameTaken(error);
  }
  const row = await loadScanner(ctx, id);
  const pairing = input.kind === 'device' ? await createPairing(ctx, userId, row, origin) : null;
  return { ...(await scannerView(ctx, id)), pairing };
}

export async function updateScanner(
  ctx: ServiceContext,
  userId: string,
  id: string,
  input: z.infer<typeof UpdateScannerSchema>,
) {
  const db = ctx.env.DB;
  const row = await loadScanner(ctx, id);
  const accepts = input.accepts
    ? await checkAccepts(ctx, row.orgId, row.mode, input.accepts)
    : null;
  const settings = input.settings
    ? ScannerSettingsSchema.parse({ ...parseSettings(row.settings), ...input.settings })
    : null;
  const now = ctx.clock.now();
  try {
    await batch(db, [
      updateScannerStmt(
        db,
        id,
        {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(settings ? { settings: JSON.stringify(settings) } : {}),
          ...(accepts ? { eventId: accepts.eventId } : {}),
        },
        now,
      ),
      ...(accepts ? replaceTemplatesStmts(db, id, accepts.templateIds) : []),
      auditStmt(db, ctx, {
        orgId: row.orgId,
        actorType: 'user',
        actorId: userId,
        action: 'scanner.update',
        targetType: 'scanner',
        targetId: id,
        detail: {
          fields: [
            ...(input.name === undefined ? [] : ['name']),
            ...(input.accepts ? ['accepts'] : []),
            ...Object.keys(input.settings ?? {}).map((k) => `settings.${k}`),
          ],
        },
      }),
    ]);
  } catch (error) {
    nameTaken(error);
  }
  return scannerView(ctx, id);
}

/** Go live / Move to Test mode. The token stays; `configRev` moves so the device refetches. */
export async function changeMode(
  ctx: ServiceContext,
  userId: string,
  id: string,
  input: z.infer<typeof ScannerModeSchema>,
) {
  const db = ctx.env.DB;
  const row = await loadScanner(ctx, id);
  if (row.mode === input.mode) return scannerView(ctx, id);
  const detach = row.eventId !== null;
  if (detach && !input.detachEvent) throw modeMismatch();
  try {
    await batch(db, [
      setModeStmt(db, id, input.mode, detach, ctx.clock.now()),
      auditStmt(db, ctx, {
        orgId: row.orgId,
        actorType: 'user',
        actorId: userId,
        action: 'scanner.mode_change',
        targetType: 'scanner',
        targetId: id,
        detail: { from: row.mode, to: input.mode, detachedEvent: detach },
      }),
    ]);
  } catch (error) {
    nameTaken(error);
  }
  return scannerView(ctx, id);
}

/** Idempotent: a second revoke changes and audits nothing. */
export async function revokeScanner(ctx: ServiceContext, userId: string, id: string) {
  const db = ctx.env.DB;
  const row = await loadScanner(ctx, id);
  if (row.revokedAt === null)
    await batch(db, [
      revokeStmt(db, id, ctx.clock.now()),
      auditStmt(db, ctx, {
        orgId: row.orgId,
        actorType: 'user',
        actorId: userId,
        action: 'scanner.revoke',
        targetType: 'scanner',
        targetId: id,
      }),
    ]);
  return scannerView(ctx, id);
}

/** One test pass of the first accepted template, filled from its sample inputs, with no holder. */
export async function createSamplePass(ctx: ServiceContext, userId: string, id: string) {
  const db = ctx.env.DB;
  const row = await loadScanner(ctx, id);
  if (row.mode !== 'test')
    throw new ValidationError('Sample passes are for test scanners.', [], 'SAMPLE_TEST_ONLY');
  const templateIds = row.eventId
    ? await eventTemplateIds(db, row.orgId, row.eventId)
    : row.templateIds;
  const template = templateIds.length
    ? await firstTemplateManifest(db, row.orgId, templateIds)
    : null;
  if (!template)
    throw new ValidationError('Choose what this scanner accepts first.', [], 'SCANNER_UNASSIGNED');
  const manifest = JSON.parse(template.manifest) as TemplateManifest;
  const pass = await createPassRow(ctx, {
    orgId: row.orgId,
    templateId: template.id,
    input: manifest.sample,
    source: 'manual',
    mode: 'test',
    actor: { type: 'user', id: userId },
  });
  await batch(db, [
    auditStmt(db, ctx, {
      orgId: row.orgId,
      actorType: 'user',
      actorId: userId,
      action: 'scanner.sample_pass',
      targetType: 'scanner',
      targetId: id,
      detail: { passId: pass.id, templateId: template.id },
    }),
  ]);
  return { passId: pass.id, templateId: template.id };
}
