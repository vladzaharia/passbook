import type { z } from 'zod';
import type { Mode } from '../../../shared/contracts/common.ts';
import type { ScannerListQuerySchema } from '../../../shared/contracts/scanners.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { setupMeta, setupMetas, watchOf } from './repo-setups.ts';
import { listScanners, scannerView } from './scanner-views.ts';

export async function listSetups(
  ctx: ServiceContext,
  mode: Mode,
  query: z.infer<typeof ScannerListQuerySchema>,
) {
  const page = await listScanners(ctx, mode, query);
  const metadata = await setupMetas(
    ctx.env.DB,
    query.orgId ?? null,
    page.items.map((s) => s.id),
  );
  return {
    ...page,
    items: page.items.map((scanner) => {
      const meta = metadata.find((m) => m.scanner_id === scanner.id);
      return {
        ...scanner,
        sessionId: meta?.session_id ?? undefined,
        adminSession: meta?.admin_session === 1,
        adminUser: meta?.admin_user_id
          ? { id: meta.admin_user_id, name: meta.admin_name ?? 'Admin' }
          : null,
        watch: watchOf(meta ?? null),
      };
    }),
  };
}

export async function setupView(ctx: ServiceContext, id: string) {
  const scanner = await scannerView(ctx, id);
  const meta = await setupMeta(ctx.env.DB, scanner.orgId, id);
  return {
    ...scanner,
    sessionId: meta?.session_id ?? undefined,
    adminSession: meta?.admin_session === 1,
    adminUser: meta?.admin_user_id
      ? { id: meta.admin_user_id, name: meta.admin_name ?? 'Admin' }
      : null,
    watch: watchOf(meta),
  };
}
