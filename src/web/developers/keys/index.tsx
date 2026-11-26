import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BENCH_KEYS_COPY } from '../../../shared/copy/developers-bench-keys.ts';
import { KEYS_COPY } from '../../../shared/copy/developers-keys.ts';
import { PATHS } from '../../../shared/developers.ts';
import { BenchState } from '../bench/state.tsx';
import { loadSession } from '../console/session.ts';
import type { Island } from '../shell/islands.ts';
import { fetchHome } from '../workbench/api.ts';
import { KeysPage } from './keys-page.tsx';
import './keys.css';
import '../ui/sheet.css';

/** The page without keys to list: the frame's heading stays, one scene says why. */
const state = (el: HTMLElement, node: ReactNode) =>
  createRoot(el).render(<div className="ks">{node}</div>);
const noSandbox = (el: HTMLElement) =>
  state(
    el,
    <BenchState scene="no-sandbox">
      <a className="btn" href={`${PATHS.quickstart}#sandbox`}>
        {KEYS_COPY.create}
      </a>
    </BenchState>,
  );
const closed = (el: HTMLElement) =>
  state(
    el,
    <BenchState scene="closed">
      <a className="btn" href={`${PATHS.quickstart}#start-over`}>
        {BENCH_KEYS_COPY.closed.action}
      </a>
    </BenchState>,
  );
const failed = (el: HTMLElement) =>
  state(
    el,
    <BenchState scene="failed" title={KEYS_COPY.failed} onRetry={() => location.reload()} />,
  );

/**
 * The `keys` island on `/developers/keys`. Signed out (or without developer access) the prerendered sign-in card
 * stays; with a sandbox it is the page: the sandbox's keys, New key, Roll.
 */
export const mount: Island['mount'] = async (el) => {
  const session = await loadSession();
  if (session.kind === 'out') return;
  if (session.kind === 'failed') return failed(el);
  if (session.kind === 'closed') return closed(el);
  if (session.kind !== 'ready') return noSandbox(el);
  try {
    const home = await fetchHome();
    if (home.state === 'none') return noSandbox(el);
    createRoot(el).render(<KeysPage initial={home} csrf={session.csrf} />);
  } catch {
    failed(el);
  }
};
