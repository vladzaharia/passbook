/** Names compare without case, as the unique indexes do. */
export type TakenNames = Set<string>;

const lower = (name: string) => name.toLowerCase();

/** The name, or the name with the lowest free number after it; either way it is now taken. */
export function pickFreeName(name: string, max: number, taken: TakenNames): string {
  let pick = name;
  for (let n = 2; taken.has(lower(pick)); n++) {
    const suffix = ` ${n}`;
    pick = `${Array.from(name)
      .slice(0, max - suffix.length)
      .join('')
      .trimEnd()}${suffix}`;
  }
  taken.add(lower(pick));
  return pick;
}

/** "<base> 1", "<base> 2", ... the first free one, cut to fit `max`. */
export function numberedName(base: string, max: number, taken: TakenNames): string {
  for (let n = 1; ; n++) {
    const suffix = ` ${n}`;
    const name = `${Array.from(base)
      .slice(0, max - suffix.length)
      .join('')
      .trimEnd()}${suffix}`;
    if (!taken.has(lower(name))) {
      taken.add(lower(name));
      return name;
    }
  }
}
