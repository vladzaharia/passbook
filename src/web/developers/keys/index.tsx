import { createRoot } from 'react-dom/client';
import { KEYS_COPY } from '../../../shared/copy/developers-keys.ts';
import { loadSession } from '../console/session.ts';
import type { Island } from '../shell/islands.ts';
import { fetchHome } from '../workbench/api.ts';
import { KeysPage } from './keys-page.tsx';
import './keys.css';
import './keys-sheet.css';

const note = (el: HTMLElement, text: string) => {
  const p = document.createElement('p');
  p.className = 'muted ks-note';
  p.textContent = text;
  el.replaceChildren(p);
};

/**
 * The `keys` island on `/developers/keys`. Signed out (or without developer access) the prerendered sign-in card
 * stays; with a sandbox it is the page: the sandbox's keys, New key, Roll.
 */
export const mount: Island['mount'] = async (el) => {
  const session = await loadSession();
  if (session.kind === 'out') return;
  if (session.kind === 'closed') return note(el, KEYS_COPY.closed);
  if (session.kind !== 'ready') return note(el, KEYS_COPY.noSandbox);
  try {
    const home = await fetchHome();
    if (home.state === 'none') return note(el, KEYS_COPY.noSandbox);
    createRoot(el).render(<KeysPage initial={home} csrf={session.csrf} hash={location.hash} />);
  } catch {
    note(el, KEYS_COPY.failed);
  }
};
