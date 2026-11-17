import { issueToken, type TokenPurpose } from '../../platform/capability-token.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { readSystemValue, writeSystemValue } from '../settings/repo.ts';
import { type PlainTokenRow, plainBundles, plainPasses, sealGrant } from './repo-token-seal.ts';

const BATCH = 50;
const CURSOR = 'tokens.sealCursor';

type Cursor = { pass: string | null; bundle: string | null };

function parseCursor(value: unknown): Cursor {
  const v = (value ?? {}) as Partial<Cursor>;
  return {
    pass: typeof v.pass === 'string' ? v.pass : null,
    bundle: typeof v.bundle === 'string' ? v.bundle : null,
  };
}

/**
 * Minute: seals the pass and bundle tokens written before 0059 (plain in the token column), 50 of each
 * a run. A pass with a pending credential transfer waits; a row that is refused (changed since it was
 * read) is retried by the next sweep. The cursor walks the id order, so a row that keeps being refused
 * never starves the rows behind it. Idempotent: a sealed row no longer matches the work list.
 */
export async function sealCapabilityTokens(ctx: ServiceContext): Promise<void> {
  const db = ctx.env.DB;
  const cursor = parseCursor(await readSystemValue(db, CURSOR));
  const [passes, bundles] = await Promise.all([
    plainPasses(db, cursor.pass, BATCH),
    plainBundles(db, cursor.bundle, BATCH),
  ]);
  if (passes.length === 0 && bundles.length === 0) {
    // The sweep reached the end: the next run starts again from the first row.
    if (cursor.pass !== null || cursor.bundle !== null)
      await writeSystemValue(db, CURSOR, { pass: null, bundle: null }, ctx.clock.now());
    return;
  }
  const sealed = { pass: 0, bundle: 0 };
  let refused = 0;
  for (const [purpose, rows] of [
    ['pass', passes],
    ['bundle', bundles],
  ] as const)
    for (const row of rows) {
      if (await sealOne(ctx, purpose, row)) sealed[purpose]++;
      else refused++;
    }
  await writeSystemValue(
    db,
    CURSOR,
    { pass: passes.at(-1)?.id ?? cursor.pass, bundle: bundles.at(-1)?.id ?? cursor.bundle },
    ctx.clock.now(),
  );
  ctx.log.info('tokens.seal', {
    code: 'TOKEN_SEAL_RUN',
    passes: sealed.pass,
    bundles: sealed.bundle,
    refused,
  });
}

async function sealOne(
  ctx: ServiceContext,
  purpose: TokenPurpose,
  row: PlainTokenRow,
): Promise<boolean> {
  const issued = await issueToken(ctx.env, purpose, row.id, row.orgId, row.token);
  try {
    await sealGrant(ctx, purpose, row, issued.mac, issued.seal).commit();
    return true;
  } catch (error) {
    if (!(error instanceof AppError) || error.status >= 500) throw error;
    ctx.log.warn('tokens.seal_refused', { code: 'TOKEN_SEAL_REFUSED', purpose, id: row.id });
    return false;
  }
}
