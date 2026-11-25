type Dict = Record<string, unknown>;

const asDict = (v: unknown): Dict => (v && typeof v === 'object' ? (v as Dict) : {});
const asNumbers = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((n): n is number => typeof n === 'number') : [];

/** The HTTP status of each code in docs/api/errors.json, whichever of the shapes it takes. A code raised with several statuses shows the first (the catalog puts the status raised at the most sites first). */
export function errorStatuses(errors: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const list = Array.isArray(errors) ? errors : asDict(errors).codes;
  const rows: Dict[] = Array.isArray(list)
    ? list.map((e) => asDict(e))
    : Object.entries(asDict(errors)).map(([code, e]) => ({ code, ...asDict(e) }));
  for (const r of rows) {
    const status = typeof r.status === 'number' ? r.status : asNumbers(r.statuses)[0];
    if (typeof r.code === 'string' && status !== undefined) out.set(r.code, status);
  }
  return out;
}
