const TAG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const REKEYED_ACTION = 'tag_keyset.rekeyed';
const SHOWN = 20;

/**
 * A re-key entry as a reader sees it: the count and the tag ids (ids, not secrets; the generic read
 * redaction blanks them as long tokens). Nothing else of the stored detail passes, so key material never can.
 */
export function rekeyedDetail(detail: unknown): { count: number; tagIds: string[] } {
  const d = (typeof detail === 'object' && detail !== null ? detail : {}) as Record<
    string,
    unknown
  >;
  const ids = Array.isArray(d.tagIds)
    ? d.tagIds.filter((v): v is string => typeof v === 'string' && TAG_ID.test(v))
    : [];
  const count = typeof d.count === 'number' && Number.isFinite(d.count) ? d.count : ids.length;
  return { count, tagIds: ids.slice(0, SHOWN) };
}
