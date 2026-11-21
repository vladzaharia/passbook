type Kid = Node | string | null | false | undefined;
type Attrs = Record<string, string | boolean | undefined>;

/** A DOM element from text only: the portal runs under Trusted Types, so nothing here ever sets HTML. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...kids: Kid[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    el.setAttribute(name, value === true ? '' : value);
  }
  for (const kid of kids) if (kid) el.append(kid);
  return el;
}

/** Replaces everything inside `el`. */
export const fill = (el: Element, ...kids: Kid[]): void =>
  el.replaceChildren(...kids.filter((k): k is Node | string => Boolean(k)));

/** A same-origin JSON GET with the session cookie; the status is returned so a caller can tell 401 from 404. */
export async function getJson<T>(path: string): Promise<{ status: number; body: T | null }> {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  return { status: res.status, body: res.ok ? ((await res.json()) as T) : null };
}
