import { issueToken, type TokenPurpose } from '../../platform/capability-token.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { readSystemValue, writeSystemValue } from '../settings/repo.ts';
import { sealTrusted } from './repo-pass-trusted.ts';
import {
  countPlain,
  countUnscrubbed,
  type PlainTokenRow,
  plainBundles,
  plainPasses,
  scrubPassJson,
  sealGrant,
} from './repo-token-seal.ts';

const BATCH = 50;
const SCRUB_BATCH = 200;
const CURSOR = 'tokens.sealCursor';

type Cursor = { pass: string | null; auth: string | null; bundle: string | null };

function parseCursor(value: unknown): Cursor {
  const v = (value ?? {}) as Partial<Cursor>;
  return {
    pass: typeof v.pass === 'string' ? v.pass : null,
    auth: typeof v.auth === 'string' ? v.auth : null,
    bundle: typeof v.bundle === 'string' ? v.bundle : null,
  };
}

/**
 * Minute: seals the pass download, Apple web-service and bundle tokens written before 0059 and 0065 (plain
 * in the token column), 50 of each a run, and removes the device token from the stored pass.json copies
 * written before 0065 (200 a run). A pass with a pending credential transfer waits; a row that is refused
 * (changed since it was read) is retried by the next sweep. The cursor walks the id order, so a row that
 * keeps being refused never starves the rows behind it. Idempotent: a sealed row no longer matches the
 * work list.
 */
export async function sealCapabilityTokens(ctx: ServiceContext): Promise<void> {
  const db = ctx.env.DB;
  const cursor = parseCursor(await readSystemValue(db, CURSOR));
  const [passes, auth, bundles, scrubbed] = await Promise.all([
    plainPasses(db, 'download_token', cursor.pass, BATCH),
    plainPasses(db, 'auth_token', cursor.auth, BATCH),
    plainBundles(db, cursor.bundle, BATCH),
    scrubPassJson(db, SCRUB_BATCH),
  ]);
  if (passes.length === 0 && auth.length === 0 && bundles.length === 0) {
    // The sweep reached the end: the next run starts again from the first row.
    if (cursor.pass !== null || cursor.auth !== null || cursor.bundle !== null)
      await writeSystemValue(db, CURSOR, { pass: null, auth: null, bundle: null }, ctx.clock.now());
    if (scrubbed > 0) ctx.log.info('tokens.seal', { code: 'TOKEN_SEAL_RUN', scrubbed });
    return;
  }
  const sealed = { pass: 0, 'apple-auth': 0, bundle: 0 };
  let refused = 0;
  for (const [purpose, rows] of [
    ['pass', passes],
    ['apple-auth', auth],
    ['bundle', bundles],
  ] as const)
    for (const row of rows) {
      if (await sealOne(ctx, purpose, row)) sealed[purpose]++;
      else refused++;
    }
  await writeSystemValue(
    db,
    CURSOR,
    {
      pass: passes.at(-1)?.id ?? cursor.pass,
      auth: auth.at(-1)?.id ?? cursor.auth,
      bundle: bundles.at(-1)?.id ?? cursor.bundle,
    },
    ctx.clock.now(),
  );
  ctx.log.info('tokens.seal', {
    code: 'TOKEN_SEAL_RUN',
    passes: sealed.pass,
    authTokens: sealed['apple-auth'],
    bundles: sealed.bundle,
    scrubbed,
    refused,
    remaining: await countPlain(db),
    unscrubbed: await countUnscrubbed(db),
  });
}

/** One row, classified on its own: a refused or failing row is counted and logged, and the sweep moves on. */
async function sealOne(
  ctx: ServiceContext,
  purpose: TokenPurpose,
  row: PlainTokenRow,
): Promise<boolean> {
  try {
    const issued = await issueToken(ctx.env, purpose, row.id, row.orgId, row.token);
    const seal = row.keepSeal ? issued.seal : null;
    if (!row.orgActive) return await sealTrusted(ctx.env.DB, purpose, row, issued.mac, seal);
    await sealGrant(ctx, purpose, row, issued.mac, seal).commit();
    return true;
  } catch (error) {
    if (error instanceof AppError && error.status < 500) {
      ctx.log.warn('tokens.seal_refused', { code: 'TOKEN_SEAL_REFUSED', purpose, id: row.id });
      return false;
    }
    // Never the token: the error's name only.
    ctx.log.error('tokens.seal_failed', {
      code: 'TOKEN_SEAL_FAILED',
      purpose,
      id: row.id,
      errorName: error instanceof Error ? error.name : 'unknown',
    });
    return false;
  }
}
