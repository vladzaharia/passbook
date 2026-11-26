import { queryOptions, useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { isWbTool, SANDBOX_ONLY, WB_TOOLS, type WbTool } from '@/shared/workbench.ts';
import { useSession } from '../../lib/session.ts';
import { sessionJson } from './session-fetch.ts';

/** `GET /workbench/contexts` (design §3.6, S5): the sandbox, then orgs whose Test this person may use. */
export const CONTEXTS_PATH = '/api/v1/workbench/contexts';

const Tools = z.array(z.string()).transform((list) => list.filter(isWbTool));
export const ContextsSchema = z.object({
  sandbox: z
    .object({
      orgId: z.string(),
      name: z.string(),
      slug: z.string().optional(),
      closed: z.boolean().optional(),
    })
    .nullable(),
  orgs: z.array(z.object({ orgId: z.string(), name: z.string(), slug: z.string(), tools: Tools })),
});

export interface WbContext {
  orgId: string;
  name: string;
  kind: 'sandbox' | 'org';
  /** The areas shown here, in nav order; the nav drops the rest and never reorders. */
  tools: readonly WbTool[];
  closed: boolean;
}

/** The sandbox first (pinned), then orgs; each with its allowed areas in nav order. */
export function toContexts(body: z.infer<typeof ContextsSchema>): WbContext[] {
  const list: WbContext[] = [];
  if (body.sandbox) {
    list.push({
      orgId: body.sandbox.orgId,
      name: body.sandbox.name,
      kind: 'sandbox',
      tools: WB_TOOLS,
      closed: body.sandbox.closed ?? false,
    });
  }
  for (const org of body.orgs) {
    const allowed = new Set<WbTool>(['home', ...org.tools]);
    list.push({
      orgId: org.orgId,
      name: org.name,
      kind: 'org',
      tools: WB_TOOLS.filter((t) => allowed.has(t) && !SANDBOX_ONLY.has(t)),
      closed: false,
    });
  }
  return list;
}

export const contextsQuery = (userId: string | undefined) =>
  queryOptions({
    queryKey: ['workbench', 'contexts', userId] as const,
    queryFn: async ({ signal }) =>
      toContexts(await sessionJson(CONTEXTS_PATH, ContextsSchema, { signal })),
    enabled: userId !== undefined,
    staleTime: 60_000,
  });

/** Polaris ID sessions only: an email link never opens the Workbench (spaces.ts). */
export function useWorkbenchContexts() {
  const { authed } = useSession();
  return useQuery(contextsQuery(authed?.amr === 'oidc' ? authed.user.id : undefined));
}

const rememberKey = (userId: string) => `wb-context:${userId}`;

/** The last context this person opened, per account. Storage may be blocked: then none. */
export function rememberedContext(userId: string): string | undefined {
  try {
    return localStorage.getItem(rememberKey(userId)) ?? undefined;
  } catch {
    return undefined;
  }
}

export function rememberContext(userId: string, orgId: string): void {
  try {
    localStorage.setItem(rememberKey(userId), orgId);
  } catch {
    // Blocked storage: the entry falls back to the sandbox, else the chooser.
  }
}

/**
 * Where a context-free path lands (design §1.1): the remembered context, else the sandbox, else
 * the only context; several and none remembered is the chooser (null).
 */
export function pickContext(list: readonly WbContext[], remembered?: string): WbContext | null {
  return (
    list.find((c) => c.orgId === remembered) ??
    list.find((c) => c.kind === 'sandbox') ??
    (list.length === 1 ? (list[0] ?? null) : null)
  );
}

/** Switching keeps the area when the new context has it, else Home (design §2.1). */
export function keepTool(target: WbContext, tool: WbTool): WbTool {
  return target.tools.includes(tool) ? tool : 'home';
}

/** The allowed area closest to a refused one in nav order, Home when none is nearer. */
export function nearestTool(tool: WbTool, allowed: readonly WbTool[]): WbTool {
  const at = WB_TOOLS.indexOf(tool);
  let best: WbTool = 'home';
  let distance = Number.POSITIVE_INFINITY;
  for (const t of allowed) {
    const d = Math.abs(WB_TOOLS.indexOf(t) - at);
    if (t !== 'home' && d < distance) {
      best = t;
      distance = d;
    }
  }
  return best;
}
