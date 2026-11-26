import type { z } from 'zod';
import type {
  OperationDto,
  OperationListQuerySchema,
} from '../../../shared/contracts/operations.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { ForbiddenError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { orgFenceFor, platformFenceFor, readFenceFor, starterFenceFor } from './authz.ts';
import { toDto } from './dto.ts';
import { orgKinds } from './kinds.ts';
import type { OperationRow } from './repo.ts';
import { rowById } from './repo.ts';
import type { Fence } from './repo-fence.ts';
import { getFenced, listFenced } from './repo-read.ts';

type Query = z.infer<typeof OperationListQuerySchema>;

const notFound = () => new NotFoundError('Operation not found.', 'OPERATION_NOT_FOUND');

/** One operation the caller may read. Unknown and unreadable are the same 404. */
export async function getOperation(
  ctx: ServiceContext,
  auth: AuthContext,
  id: string,
): Promise<OperationDto> {
  return toDto((await readable(ctx, auth, id)).row);
}

export async function readable(
  ctx: ServiceContext,
  auth: AuthContext,
  id: string,
  capability: 'read' | 'write' = 'read',
): Promise<{ row: OperationRow; fence: Fence }> {
  const known = await rowById(ctx.env.DB, id);
  if (!known) throw notFound();
  // Reads first: a caller who cannot read it must not learn that it exists, even to be told 403.
  const readFence = await readFenceFor(ctx, auth, known, 'read');
  const row = readFence ? await getFenced(ctx.env.DB, readFence, id) : null;
  if (!row || !readFence) throw notFound();
  if (capability === 'read') return { row, fence: readFence };
  const writeFence = await readFenceFor(ctx, auth, known, 'write');
  if (!writeFence || !(await getFenced(ctx.env.DB, writeFence, id))) throw new ForbiddenError();
  return { row, fence: writeFence };
}

function decodeCursor(cursor: string | undefined): { createdAt: number; id: string } | null {
  if (!cursor) return null;
  const [at, ...rest] = cursor.split('.');
  const createdAt = Number(at);
  const id = rest.join('.');
  if (!Number.isSafeInteger(createdAt) || !id)
    throw new ValidationError('Invalid cursor.', [], 'INVALID_CURSOR');
  return { createdAt, id };
}

/** Org operations of an org the caller may read, one query per read capability the kinds need. */
async function orgFences(
  ctx: ServiceContext,
  auth: AuthContext,
  orgId: string | null,
): Promise<{ fence: Fence; kinds: string[] }[]> {
  if (!orgId) return [];
  const byCapability = new Map<string, string[]>();
  for (const def of orgKinds())
    byCapability.set(def.read as string, [
      ...(byCapability.get(def.read as string) ?? []),
      def.kind,
    ]);
  const out: { fence: Fence; kinds: string[] }[] = [];
  for (const [capability, kinds] of byCapability) {
    const fence = await orgFenceFor(ctx, auth, orgId, capability as never);
    if (fence) out.push({ fence, kinds });
  }
  return out;
}

/** The caller's operations, newest first: started by them, in an org they read, or platform-wide for admins. */
export async function listOperations(
  ctx: ServiceContext,
  auth: AuthContext,
  query: Query,
): Promise<{ items: OperationDto[]; nextCursor: string | null }> {
  const target = query.target
    ? {
        type: query.target.split(':')[0] ?? '',
        id: query.target.slice(query.target.indexOf(':') + 1),
      }
    : null;
  const orgId = query.orgId ?? (auth.kind === 'api_key' ? auth.orgId : null);
  const actor =
    query.mine === true && auth.kind !== 'scanner'
      ? auth.kind === 'session'
        ? ({ type: 'user', id: auth.userId } as const)
        : ({ type: 'api_key', id: auth.keyId } as const)
      : null;
  const base = {
    active: query.active === true,
    kind: query.kind ?? null,
    target,
    after: decodeCursor(query.cursor),
    limit: query.limit + 1,
  };
  const fences: { fence: Fence; kinds: string[] | null }[] = [];
  const starter = starterFenceFor(ctx, auth);
  if (starter) fences.push({ fence: starter, kinds: null });
  const platform = platformFenceFor(ctx, auth);
  if (platform) fences.push({ fence: platform, kinds: null });
  for (const org of await orgFences(ctx, auth, orgId)) fences.push(org);
  const rows: OperationRow[] = [];
  for (const { fence, kinds } of fences)
    rows.push(...(await listFenced(ctx.env.DB, fence, { ...base, actor, kinds })));
  rows.sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1));
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toDto),
    nextCursor: rows.length > query.limit && last ? `${last.created_at}.${last.id}` : null,
  };
}
