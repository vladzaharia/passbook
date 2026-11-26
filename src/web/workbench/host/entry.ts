import type { QueryClient } from '@tanstack/react-query';
import { redirect } from '@tanstack/react-router';
import { type WbTool, wbPath } from '@/shared/workbench.ts';
import { sessionQuery } from '../../lib/session.ts';
import {
  contextsQuery,
  keepTool,
  pickContext,
  rememberedContext,
  type WbContext,
} from './contexts.ts';

/**
 * A context-free path (`/workbench`, `/workbench/console?op=…`) resolves to the remembered
 * context, else the sandbox, else the only one (design §1.1), keeping its query and hash. With
 * several and none remembered, or none at all, the page stays and shows the chooser or the reason.
 * Signed out, or when the contexts fail to load, the layout says so instead.
 */
export async function enterContext(
  queryClient: QueryClient,
  tool: WbTool,
  tail: { searchStr: string; hash: string },
): Promise<void> {
  const session = await queryClient.ensureQueryData(sessionQuery);
  if (!session.authenticated || session.amr !== 'oidc') return;
  let list: WbContext[];
  try {
    list = await queryClient.ensureQueryData(contextsQuery(session.user.id));
  } catch {
    // The layout renders the failure with Retry; no redirect from here.
    return;
  }
  const target = pickContext(list, rememberedContext(session.user.id));
  if (!target) return;
  const path = wbPath(target.orgId, keepTool(target, tool));
  throw redirect({
    href: `${path}${tail.searchStr}${tail.hash ? `#${tail.hash}` : ''}`,
    replace: true,
  });
}
