// One D1 transaction for several grants. Kept apart from `Grant` so the class stays small.
import { AuthorityError } from './authority-error.ts';

/** What a batch needs of a grant; `Grant` is the only implementation. */
export interface BatchGrant {
  readonly codesKey: string;
  translate(error: unknown): unknown;
}

let prepare: (g: BatchGrant) => D1PreparedStatement[];

/** Called once by the `Grant` class so the batch can reach its private `#prepare`. */
export function registerPrepare(fn: (g: BatchGrant) => D1PreparedStatement[]): void {
  prepare = fn;
}

export const prepareOf = (g: BatchGrant): D1PreparedStatement[] => prepare(g);

/**
 * One transaction for several grants: [grant, writes, release] for each, in order.
 *
 * Choose ONE grant per batch. Several are allowed only when they share the same refusal `codes`,
 * because a refusal is translated with the codes of the grants together, not of the one that failed.
 * They run in order: grant B's checks see grant A's writes (B is evaluated after A's statements).
 */
export async function grantedBatch(db: D1Database, grants: BatchGrant[]): Promise<D1Result[][]> {
  return (await grantedBatchWith(db, grants, [])).grants;
}

/**
 * `grantedBatch` plus plain statements that run after the last release, in the same transaction.
 * For reads that must see the grant's writes in one round trip; they carry no authority and write nothing.
 */
export async function grantedBatchWith(
  db: D1Database,
  grants: BatchGrant[],
  after: D1PreparedStatement[],
): Promise<{ grants: D1Result[][]; after: D1Result[] }> {
  if (grants.length === 0) return { grants: [], after: [] };
  if (grants.some((g) => g.codesKey !== grants[0]?.codesKey))
    throw new AuthorityError('GRANT_BATCH_MIXED', 'Grants in one batch must share their codes.');
  const prepared = grants.map((g) => prepare(g));
  let results: D1Result[];
  try {
    results = await db.batch([...prepared.flat(), ...after]);
  } catch (error) {
    throw grants.reduce((e, g) => g.translate(e), error);
  }
  const out: D1Result[][] = [];
  let at = 0;
  for (const statements of prepared) {
    out.push(results.slice(at + 1, at + statements.length - 1));
    at += statements.length;
  }
  return { grants: out, after: results.slice(at) };
}
