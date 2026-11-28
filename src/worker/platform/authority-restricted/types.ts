/** What one area contributes: its restricted tables, and the purposes that may only insert. */
export interface RestrictedEntries {
  restricted?: Readonly<Record<string, readonly string[]>>;
  insertOnly?: Readonly<Record<string, readonly string[]>>;
}
