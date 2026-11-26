import { loadSession } from './session.ts';

/** The phone sheet: the same console in a dialog. Returns the function that takes it down. */
export async function mountSheet(
  body: HTMLElement,
  slug: string,
  opId: string,
): Promise<() => void> {
  const session = await loadSession();
  if (session.kind === 'out') {
    const p = document.createElement('p');
    p.className = 'muted sm';
    p.textContent = 'Nothing is issued.';
    const a = document.createElement('a');
    a.className = 'btn';
    a.href = '/login?next=%2Fdevelopers';
    a.textContent = 'Sign in to try';
    body.replaceChildren(p, a);
    return () => body.replaceChildren();
  }
  const { mountRun } = await import('./app/mount.tsx');
  return mountRun(body, { session, mode: 'sheet', slug, opId });
}
