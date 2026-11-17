/** Preserve predicate order while bounding long, generated AND trees for D1's expression depth. */
export function scanConjunction(parts: readonly string[]): string {
  if (!parts.length) return '1';
  const groups: string[] = [];
  for (let index = 0; index < parts.length; index += 4)
    groups.push(
      `(${parts
        .slice(index, index + 4)
        .map((part) => `(${part})`)
        .join(' AND ')})`,
    );
  return groups.join(' AND ');
}
