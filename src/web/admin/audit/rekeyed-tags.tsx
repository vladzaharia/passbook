/** Tag ids a replace import re-keyed: a short list, then "and N more". Null for any other entry. */
export function rekeyedTags(action: string, detail: unknown) {
  if (action !== 'tag_keyset.rekeyed' || typeof detail !== 'object' || detail === null) return null;
  const { count, tagIds } = detail as { count?: unknown; tagIds?: unknown };
  const ids = Array.isArray(tagIds) ? tagIds.filter((v): v is string => typeof v === 'string') : [];
  const total = typeof count === 'number' ? count : ids.length;
  return { total, ids, more: Math.max(0, total - ids.length) };
}

export function RekeyedTags({ tags }: { tags: NonNullable<ReturnType<typeof rekeyedTags>> }) {
  return (
    <section aria-label="Tags re-keyed" className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-fg-strong">
        {tags.total === 1 ? '1 tag re-keyed' : `${tags.total} tags re-keyed`}
      </h3>
      <ul className="flex flex-col gap-1">
        {tags.ids.map((id) => (
          <li key={id} className="break-all font-mono text-xs text-fg-muted">
            {id}
          </li>
        ))}
      </ul>
      {tags.more > 0 ? <p className="text-sm text-fg-muted">and {tags.more} more</p> : null}
    </section>
  );
}
