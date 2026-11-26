import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import '../../ui/art/scenes/common.css';
import '../../ui/art/scenes/wave.css';
import './workbench.css';
import './workbench-cards.css';
import type { DeveloperHome } from '../../../shared/contracts/developer-home.ts';
import { PATHS } from '../../../shared/developers.ts';
import { loadSession } from '../console/session.ts';
import type { Island } from '../shell/islands.ts';
import { fetchHome, HomeError } from './api.ts';
import { WorkbenchIsland } from './island.tsx';

/**
 * The `workbench` island in `#workbench` on `/developers`, under the hero. Signed out, or signed in without developer
 * access, the prerendered sandbox card stays. Otherwise the Workbench takes the card's place in the same slot; the
 * landing around it is never touched.
 */
export const mount: Island['mount'] = async (el) => {
  const session = await loadSession();
  if (session.kind === 'out') return;
  let home: DeveloperHome | undefined;
  try {
    home = await fetchHome();
  } catch (error) {
    // No developer access: the public home is the right page. Anything else: the island shows Retry.
    if (error instanceof HomeError && error.out) return;
  }
  // Committed before the slot is shown again (shell/islands.ts), so the static card never flashes back.
  const root = createRoot(el);
  flushSync(() => root.render(<WorkbenchIsland {...(home ? { initial: home } : {})} />));
  landOnWorkbench(el);
  addEventListener('hashchange', () => landOnWorkbench(el));
};

/**
 * A link to `/developers#workbench` lands on the Workbench: it was drawn after the browser scrolled to the hash
 * (the slot's height changed), so it scrolls once more, and focus goes to the region so a screen reader says where it is.
 */
function landOnWorkbench(el: HTMLElement): void {
  if (location.hash !== PATHS.workbench.slice(PATHS.home.length)) return;
  el.setAttribute('role', 'region');
  el.setAttribute('aria-label', 'Workbench');
  el.tabIndex = -1;
  el.scrollIntoView({ block: 'start' });
  el.focus({ preventScroll: true });
}
