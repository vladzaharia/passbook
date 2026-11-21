const fresh = new Set<string>();

/** The source step just made this import: it opens at Match, not at the check a saved mapping already ran. */
export const markFresh = (id: string) => void fresh.add(id);

export function takeFresh(id: string): boolean {
  return fresh.delete(id);
}
