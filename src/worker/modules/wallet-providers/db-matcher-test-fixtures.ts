/** Matches the binding by identity; vitest inspects expected arguments eagerly and a D1 stub cannot be inspected. */
export function sameDb(db: D1Database): D1Database {
  return {
    asymmetricMatch: (value: unknown) => value === db,
    toString: () => 'D1Database',
  } as unknown as D1Database;
}
