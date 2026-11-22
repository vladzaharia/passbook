import { RAIL_COPY } from '../../../shared/copy/developers-ops.ts';
import { loadSession } from '../console/session.ts';
import type { Island } from '../shell/islands.ts';
import { fill, h } from './dom.ts';
import { mountLogs } from './island.ts';
import { loadOps } from './ops.ts';
import { mountRail } from './rail.ts';
import { showFailed, showNoSandbox } from './state.tsx';

/**
 * The log island: the list, with the operation index loaded only when a row opens. Signed out the prerendered state
 * stays and nothing is asked of the API; without a sandbox there is no log to ask for, so no call is made either.
 */
export const logsIsland: Island = {
  mount: async (el) => {
    const session = await loadSession();
    if (session.kind === 'out') return;
    if (session.kind === 'ready') return mountLogs(el, loadOps());
    if (session.kind === 'failed') return showFailed(el, () => location.reload());
    showNoSandbox(el, session.kind === 'closed');
  },
};
export const railIsland: Island = {
  mount: async (el) => {
    const session = await loadSession();
    if (session.kind === 'out') return;
    if (session.kind === 'ready') return mountRail(el);
    fill(
      el,
      h('h3', { class: 'h3' }, RAIL_COPY.title),
      h(
        'p',
        { class: 'sm muted' },
        session.kind === 'failed' ? RAIL_COPY.failed : RAIL_COPY.noSandbox,
      ),
    );
  },
};
