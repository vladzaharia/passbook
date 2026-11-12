import type { z } from 'zod';
import type { Mode } from '../../../shared/contracts/common.ts';
import type { ScannerListQuerySchema } from '../../../shared/contracts/scanners.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { dayStartMs, scannerDto } from './dto-console.ts';
import {
  type ConsoleScannerRow,
  countToday,
  getConsoleScanner,
  listConsoleScanners,
} from './repo-scanners.ts';
import { scanningDeviceRow } from './repo-scanning-devices.ts';
import { scanningSessionForDevice } from './repo-scanning-sessions.ts';
import { readScannerScope } from './repo-scope.ts';
import {
  conflictsWithAllScope,
  effectiveSessionSettings,
  resolveSessionScope,
} from './scanning-session-dto.ts';

async function withToday(ctx: ServiceContext, rows: ConsoleScannerRow[]) {
  const now = ctx.clock.now();
  const counts = await countToday(
    ctx.env.DB,
    rows
      .filter((r) => r.kind !== 'display')
      .map((r) => ({ id: r.id, since: dayStartMs(r.timeZone, now) })),
  );
  return Promise.all(
    rows.map(async (row) => {
      const dto = scannerDto(row, now, counts.get(row.id) ?? 0);
      const [parent, device, scannerScope] = await Promise.all([
        scanningSessionForDevice(ctx.env.DB, row.orgId, row.id),
        scanningDeviceRow(ctx.env.DB, row.orgId, row.id),
        readScannerScope(ctx.env.DB, row, null),
      ]);
      if (parent) {
        const scope = await resolveSessionScope(ctx, parent);
        const settings =
          device && device.session_id === parent.id
            ? effectiveSessionSettings(parent, device)
            : null;
        if (
          !settings ||
          parent.mode !== row.mode ||
          !scannerScope.valid ||
          (await conflictsWithAllScope(ctx, row, scope, settings))
        ) {
          return {
            ...dto,
            accepts: null,
            settings: { ...dto.settings, acceptAllTemplates: false },
          };
        }
        return {
          ...dto,
          accepts: scope.accepts,
          settings: scope.restricted ? { ...settings, acceptAllTemplates: false } : settings,
        };
      }
      return {
        ...dto,
        accepts: !scannerScope.valid
          ? null
          : scannerScope.event
            ? { eventId: scannerScope.event.id }
            : scannerScope.templateIds.length
              ? { templateIds: scannerScope.templateIds }
              : null,
        settings: scannerScope.restricted
          ? { ...dto.settings, acceptAllTemplates: false }
          : dto.settings,
      };
    }),
  );
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

/** A scanner by id, or 404. With `mode`, a scanner of the other mode is a 404 too. */
export async function loadScanner(
  ctx: ServiceContext,
  id: string,
  mode?: Mode,
): Promise<ConsoleScannerRow> {
  const row = await getConsoleScanner(ctx.env.DB, id, mode);
  if (!row) throw new NotFoundError('Scanner not found.', 'SCANNER_NOT_FOUND');
  return row;
}

export async function scannerView(ctx: ServiceContext, id: string) {
  const [dto] = await withToday(ctx, [await loadScanner(ctx, id)]);
  if (!dto) throw new NotFoundError('Scanner not found.', 'SCANNER_NOT_FOUND');
  return dto;
}
