import { PHONE } from './phone.ts';
import { loadSession } from './session.ts';
import { watchSession } from './watch-session.ts';

/** What a Run slot says in the DOM: which page's operations, and which one. */
function ids(el: HTMLElement): { slug?: string; opId?: string } {
  const { slug, op } = el.dataset;
  return { ...(slug ? { slug } : {}), ...(op ? { opId: op } : {}) };
}

/**
 * The `run` island, a reference page's Try it. Signed out, the prerendered ticket stays as it is and no React loads. Signed
 * in, the slot shows its skeleton (same size, so nothing moves) while the console chunk arrives.
 */
export async function mount(el: HTMLElement): Promise<void> {
  watchSession();
  const session = await loadSession();
  if (session.kind === 'out') return;
  if (matchMedia(PHONE).matches) {
    el.dataset.state = 'ready';
    return;
  }
  el.dataset.state = 'loading';
  const { mountRun } = await import('./app/mount.tsx');
  mountRun(el, { session, mode: 'op', ...ids(el) });
}

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
