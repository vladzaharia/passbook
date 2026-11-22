/**
 * Radix hides what lies outside an open modal menu with aria-hidden, but its focusable controls
 * stay reachable for assistive tech. Marks every other child of <body> inert while `node` is
 * mounted; the returned function restores them. Elements already inert stay so.
 */
export function inertOutside(node: HTMLElement): () => void {
  const changed: HTMLElement[] = [];
  for (const el of Array.from(document.body.children)) {
    if (!(el instanceof HTMLElement) || el.contains(node) || el.inert) continue;
    el.inert = true;
    changed.push(el);
  }
  return () => {
    for (const el of changed) el.inert = false;
  };
}
