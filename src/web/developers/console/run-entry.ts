import { PHONE } from './phone.ts';
import { loadSession } from './session.ts';
import { onSignedOut } from './token.ts';

/** What a Run slot says in the DOM: which page's operations, and which one. */
function ids(el: HTMLElement): { slug?: string; opId?: string } {
  const { slug, op } = el.dataset;
  return { ...(slug ? { slug } : {}), ...(op ? { opId: op } : {}) };
}

/**
 * The `run` island. Signed out, the prerendered ticket stays as it is and no React loads. Signed
 * in, the slot shows its skeleton (same size, so nothing moves) while the console chunk arrives.
 */
export async function mount(el: HTMLElement): Promise<void> {
  watchSession();
  const session = await loadSession();
  if (session.kind === 'out') return;
  const full = el.dataset.mode === 'console';
  if (!full && matchMedia(PHONE).matches) {
    el.dataset.state = 'ready';
    return;
  }
  el.dataset.state = 'loading';
  const { mountRun } = await import('./app/mount.tsx');
  mountRun(el, { session, mode: full ? 'console' : 'op', ...ids(el) });
}

/** The phone sheet: the same console in a dialog. Returns the function that takes it down. */
export async function mountSheet(
  body: HTMLElement,
  slug: string,
  opId: string,
): Promise<() => void> {
  const session = await loadSession();
  if (session.kind === 'out') {
    const h = document.createElement('h3');
    h.className = 'h2';
    h.textContent = 'Sign in to try';
    const p = document.createElement('p');
    p.className = 'muted sm';
    p.textContent = 'Nothing is issued.';
    const a = document.createElement('a');
    a.className = 'btn';
    a.href = '/login?next=%2Fdevelopers';
    a.textContent = 'Sign in to try';
    body.replaceChildren(h, p, a);
    return () => body.replaceChildren();
  }
  const { mountRun } = await import('./app/mount.tsx');
  return mountRun(body, { session, mode: 'sheet', slug, opId });
}

let watching = false;

/** A signed-out session, or a page restored from the back/forward cache, starts from the server again. */
function watchSession(): void {
  if (watching) return;
  watching = true;
  onSignedOut(() => location.reload());
  addEventListener('pageshow', (e) => {
    if (e.persisted) location.reload();
  });
}
