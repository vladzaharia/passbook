/** The pass page's title: what the pass is, never the holder (their name is a field). */
export interface PassHeading {
  /** "Henry’s Gymnasium membership": the h1 of a one-line title, and the tab title. */
  title: string;
  org: string;
  /** "Membership": the h1 under the org's name; null when the description is the org alone. */
  kind: string | null;
}

const fold = (s: string) => s.replace(/[’‘]/g, "'").toLowerCase();
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** "Membership card" -> "membership card"; "VIP pass" stays. */
const lower = (s: string) =>
  /^\p{Lu}\p{Ll}/u.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s;

/**
 * Passes carry the description `{Org} {kind}` (ux-principles.md, Pass design): it splits at the
 * org's name, from the pass or the org record. One without the org gets it in front; none at all
 * falls back to `fallback` (the pass's title).
 */
export function passHeading(
  description: string,
  orgs: readonly string[],
  fallback: string,
): PassHeading {
  const text = description.trim();
  const named = orgs.map((o) => o.trim()).filter(Boolean);
  const org = named.find((o) => fold(text).startsWith(fold(o))) ?? named[0] ?? '';
  if (!text) return { title: fallback, org, kind: null };
  if (!org) return { title: capital(text), org, kind: capital(text) };
  if (!fold(text).startsWith(fold(org))) {
    return { title: `${org} ${lower(text)}`, org, kind: capital(text) };
  }
  const rest = text.slice(org.length).trim();
  return { title: text, org, kind: rest ? capital(rest) : null };
}
