import { type TokenPurpose, tokenMac, unsealToken } from '../../platform/capability-token.ts';
import { macKeyVersion, macPreviousVersion } from '../../platform/crypto.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { readSystemValue, writeSystemValue } from '../settings/repo.ts';
import { remacTrusted } from './repo-pass-trusted.ts';
import { type MacRow, macRows } from './repo-token-remac.ts';

const BATCH = 100;
const CURSOR = 'tokens.remacCursor';
const DONE = 'tokens.remacDone';
const UNREADABLE = new Set(['TOKEN_SEAL_MISSING', 'TOKEN_SEAL_UNREADABLE', 'TOKEN_SEAL_MISMATCH']);
const PURPOSES = ['pass', 'apple-auth', 'bundle'] as const;

type Cursor = { after: Record<TokenPurpose, string | null>; skipped: number };
type Outcome = 'moved' | 'current' | 'skipped' | 'unreadable';

function parseCursor(value: unknown): Cursor {
  const v = (value ?? {}) as { after?: Partial<Record<TokenPurpose, unknown>>; skipped?: unknown };
  const id = (k: TokenPurpose) =>
    typeof v.after?.[k] === 'string' ? (v.after[k] as string) : null;
  return {
    after: { pass: id('pass'), 'apple-auth': id('apple-auth'), bundle: id('bundle') },
    skipped: typeof v.skipped === 'number' ? v.skipped : 0,
  };
}

/**
 * Minute, while `MAC_KEY_VERSION_PREVIOUS` is set: rewrites the pass link, Apple web-service and bundle token
 * MACs from their sealed copies under the current MAC root, 100 of each a run, in id order. A row refused
 * (pending transfer, forwarding reservation, changed since it was read) makes the sweep run again; a row
 * with no sealed copy (deleted pass, deleted org) or a copy that does not match is counted and left on the
 * previous root. When a sweep ends clean the pair of versions is recorded and the job stops; the owner then
 * unsets MAC_KEY_VERSION_PREVIOUS (docs/operations.md, MAC key rotation).
 */
export async function remacCapabilityTokens(ctx: ServiceContext): Promise<void> {
  const previous = macPreviousVersion(ctx.env);
  if (previous === null) return;
  const stamp = `${previous}>${macKeyVersion(ctx.env)}`;
  const db = ctx.env.DB;
  if ((await readSystemValue(db, DONE)) === stamp) return;
  const cursor = parseCursor(await readSystemValue(db, CURSOR));
  const lists = await Promise.all(PURPOSES.map((p) => macRows(db, p, cursor.after[p], BATCH)));
  if (lists.every((rows) => rows.length === 0)) {
    const again = cursor.skipped > 0;
    await writeSystemValue(db, CURSOR, parseCursor(null), ctx.clock.now());
    if (!again) await writeSystemValue(db, DONE, stamp, ctx.clock.now());
    ctx.log.info('tokens.remac', {
      code: again ? 'TOKEN_REMAC_RESWEEP' : 'TOKEN_REMAC_DONE',
      stamp,
    });
    return;
  }
  const counts: Record<Outcome, number> = { moved: 0, current: 0, skipped: 0, unreadable: 0 };
  const next = { ...cursor.after };
  for (const [i, purpose] of PURPOSES.entries()) {
    const rows = lists[i] ?? [];
    for (const row of rows) counts[await remacOne(ctx, purpose, row)]++;
    next[purpose] = rows.at(-1)?.id ?? cursor.after[purpose];
  }
  await writeSystemValue(
    db,
    CURSOR,
    { after: next, skipped: cursor.skipped + counts.skipped },
    ctx.clock.now(),
  );
  ctx.log.info('tokens.remac', { code: 'TOKEN_REMAC_RUN', stamp, ...counts });
}

/** One row on its own: a refused or failing row is counted and logged, and the sweep moves on. */
async function remacOne(ctx: ServiceContext, purpose: TokenPurpose, row: MacRow): Promise<Outcome> {
  try {
    const plain = await unsealToken(ctx.env, purpose, row.id, row.orgId, row.mac, row.seal);
    const to = await tokenMac(ctx.env, purpose, plain);
    if (to === row.mac) return 'current';
    return (await remacTrusted(ctx.env.DB, purpose, row.id, row.mac, to)) ? 'moved' : 'skipped';
  } catch (error) {
    // unsealToken logged a missing, unreadable or mismatching copy: it stays on the previous root.
    if (error instanceof AppError && UNREADABLE.has(error.code)) return 'unreadable';
    ctx.log.error('tokens.remac_failed', {
      code: 'TOKEN_REMAC_FAILED',
      purpose,
      id: row.id,
      errorName: error instanceof Error ? error.name : 'unknown',
    });
    return 'skipped';
  }
}
