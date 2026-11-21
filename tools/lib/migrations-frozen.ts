/** A migration on the base ref is frozen: production may have applied it, so it never changes in place. */
export interface FrozenInput {
  /** Each migration file on the base ref, with its content there. */
  base: ReadonlyMap<string, string>;
  /** The same files as they are now; null when the file was deleted. */
  read: (file: string) => string | null;
}

/** One line per migration that changed or vanished since the base ref. */
export function frozenFailures({ base, read }: FrozenInput): string[] {
  const out: string[] = [];
  for (const [file, before] of base) {
    const now = read(file);
    if (now === null)
      out.push(`${file}: deleted, but it is on the base ref (add a new migration instead)`);
    else if (now !== before)
      out.push(
        `${file}: changed, but it is on the base ref (production may have applied it; add a new migration)`,
      );
  }
  return out.sort();
}
