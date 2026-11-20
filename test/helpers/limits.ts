import { beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../src/worker/platform/db.ts';

/** What an over-limit create answers: the problem the API sends. */
export interface Refused {
  status: number;
  code: string;
  feature?: string | undefined;
  limit?: number | undefined;
  used?: number | undefined;
  detail: string;
}

/** One create path under test, bound to an org that starts on the `legacy` preset (no limits). */
export interface LimitKind {
  db: D1Database;
  orgId: string;
  /** The entitlement key whose cap the path enforces. */
  key: string;
  /** One create through the real path: null when it was made, else the refusal. */
  create(): Promise<Refused | null>;
  /** What the org holds now, counted the way the limit counts it. */
  count(): Promise<number>;
}

/** A per-org override of one limit, as a platform admin's override would store it. */
export async function setLimit(
  db: D1Database,
  orgId: string,
  key: string,
  value: number | null,
): Promise<void> {
  await run(
    db,
    'INSERT OR REPLACE INTO org_entitlement_overrides (org_id, key, value, updated_at) VALUES (?, ?, ?, 1)',
    [orgId, key, JSON.stringify(value)],
  );
}

/** A problem+json response as a `Refused`; null for a 2xx. */
export async function refusedBy(response: Response): Promise<Refused | null> {
  if (response.ok) return null;
  const body = (await response.json()) as Refused;
  return { ...body, status: response.status };
}

/** A thrown AppError (a service call) as a `Refused`; null when the call returned. */
export async function refusedWhen(call: () => Promise<unknown>): Promise<Refused | null> {
  try {
    await call();
    return null;
  } catch (error) {
    const e = error as Partial<Refused> & { message: string };
    if (typeof e.status !== 'number' || typeof e.code !== 'string') throw error;
    return {
      status: e.status,
      code: e.code,
      feature: e.feature,
      limit: e.limit,
      used: e.used,
      detail: e.message,
    };
  }
}

/**
 * The limit contract of one create path: no value means no limit, n-1 succeeds and n is refused with the
 * limit and usage, two creates racing at n-1 let exactly one through, and a downgrade below what exists
 * keeps it all and only blocks new creates.
 */
export function limitSuite(
  name: string,
  setup: () => Promise<LimitKind>,
  /** A public path answers with its own code and does not name the plan: `{ code: 'JOIN_LIMIT', plain: true }`. */
  options: { code?: string; plain?: boolean } = {},
): void {
  const code = options.code ?? 'FEATURE_LIMIT_REACHED';
  describe(`${name} limit`, () => {
    let k: LimitKind;
    const cap = (value: number | null) => setLimit(k.db, k.orgId, k.key, value);

    beforeAll(async () => {
      k = await setup();
    });

    it('a legacy org (no limit) creates freely', async () => {
      const before = await k.count();
      for (let i = 0; i < 3; i++) expect(await k.create()).toBeNull();
      expect(await k.count()).toBe(before + 3);
    });

    it('n-1 succeeds and n is refused with the limit and usage', async () => {
      const held = await k.count();
      await cap(held + 1);
      expect(await k.create()).toBeNull();
      const refused = await k.create();
      expect(refused?.code).toBe(code);
      if (!options.plain) {
        expect(refused).toMatchObject({
          status: 403,
          feature: k.key,
          limit: held + 1,
          used: held + 1,
        });
        // One sentence, naming the cap and the count.
        expect(refused?.detail).toMatch(new RegExp(`\\(${held + 1} of ${held + 1}\\)`));
        expect(refused?.detail.match(/\./g)?.length ?? 0).toBeLessThanOrEqual(1);
      }
      expect(await k.count()).toBe(held + 1);
    });

    it('two creates racing at n-1 let exactly one through', async () => {
      const held = await k.count();
      await cap(held + 1);
      const results = await Promise.all([k.create(), k.create()]);
      expect(results.filter((r) => r === null)).toHaveLength(1);
      expect(results.filter((r) => r?.code === code)).toHaveLength(1);
      expect(await k.count()).toBe(held + 1);
    });

    it('a downgrade keeps what exists and only blocks new creates', async () => {
      const held = await k.count();
      await cap(Math.max(held - 2, 0));
      expect(await k.count()).toBe(held);
      expect((await k.create())?.code).toBe(code);
      expect(await k.count()).toBe(held);
      await cap(null);
      expect(await k.create()).toBeNull();
      expect(await k.count()).toBe(held + 1);
    });
  });
}
