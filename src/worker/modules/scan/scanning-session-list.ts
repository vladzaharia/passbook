import type { z } from 'zod';
import type { Mode } from '../../../shared/contracts/common.ts';
import type { ScanningSessionQuerySchema } from '../../../shared/contracts/scanning-sessions.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { listScanningSessionRows } from './repo-scanning-sessions.ts';
import { assertSessionReadAuthority } from './scanning-session-authority.ts';
import { type SessionCountAuthority, sessionDto } from './scanning-session-dto.ts';

export async function listScanningSessions(
  ctx: ServiceContext,
  mode: Mode,
  query: z.infer<typeof ScanningSessionQuerySchema>,
  authority: TenantPassWrite,
  countAuthority: SessionCountAuthority,
) {
  assertSessionReadAuthority(mode, authority, countAuthority);
  if (query.orgId !== authority.orgId) throw new ForbiddenError();
  const rows = await listScanningSessionRows(ctx.env.DB, mode, query);
  const page = rows.slice(0, query.limit);
  return {
    items: await Promise.all(page.map((row) => sessionDto(ctx, row, countAuthority))),
    nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
  };
}
