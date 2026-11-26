import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { KEYS_COPY } from '../../../shared/copy/developers-keys.ts';
import { PATHS } from '../../../shared/developers.ts';
import { loadSession } from '../console/session.ts';
import type { Island } from '../shell/islands.ts';
import { Retry, StateCard } from '../ui/state-card.tsx';
import { fetchHome } from '../workbench/api.ts';
import { KeysPage } from './keys-page.tsx';
import './keys.css';
import '../ui/sheet.css';

/** The page without keys to list: the frame's heading stays, one state card says why. */
const state = (el: HTMLElement, node: ReactNode) =>
  createRoot(el).render(<div className="ks">{node}</div>);
const noSandbox = (el: HTMLElement) =>
  state(
    el,
    <StateCard kind="empty" title={KEYS_COPY.noSandbox}>
      <a className="btn" href={`${PATHS.quickstart}#sandbox`}>
        {KEYS_COPY.create}
      </a>
    </StateCard>,
  );
const failed = (el: HTMLElement) =>
  state(
    el,
    <StateCard kind="error" title={KEYS_COPY.failed}>
      <Retry onClick={() => location.reload()} />
    </StateCard>,
  );

/**
 * The `keys` island on `/developers/keys`. Signed out (or without developer access) the prerendered sign-in card
 * stays; with a sandbox it is the page: the sandbox's keys, New key, Roll.
 */
export const mount: Island['mount'] = async (el) => {
  const session = await loadSession();
  if (session.kind === 'out') return;
  if (session.kind === 'failed') return failed(el);
  if (session.kind === 'closed')
    return state(el, <StateCard kind="empty" title={KEYS_COPY.closed} />);
  if (session.kind !== 'ready') return noSandbox(el);
  try {
    const home = await fetchHome();
    if (home.state === 'none') return noSandbox(el);
    createRoot(el).render(<KeysPage initial={home} csrf={session.csrf} hash={location.hash} />);
  } catch {
    failed(el);
  }
};
