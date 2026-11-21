import { type PassView, PassViewListSchema } from '../../../shared/contracts/pass-views.ts';
import { readSystemValue, writeSystemValue } from '../settings/repo.ts';

const KEY = (orgId: string) => `passes.views:${orgId}`;

/** The org's saved views; a stored value that no longer parses reads as none. */
export async function readPassViews(db: D1Database, orgId: string): Promise<PassView[]> {
  const parsed = PassViewListSchema.safeParse({ items: await readSystemValue(db, KEY(orgId)) });
  return parsed.success ? parsed.data.items : [];
}

export async function writePassViews(
  db: D1Database,
  orgId: string,
  items: PassView[],
  now: number,
): Promise<void> {
  await writeSystemValue(db, KEY(orgId), items, now);
}
