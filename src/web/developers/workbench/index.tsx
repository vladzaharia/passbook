import { createRoot } from 'react-dom/client';
import '../../ui/art/scenes/common.css';
import '../../ui/art/scenes/wave.css';
import './workbench.css';
import './workbench-cards.css';
import type { DeveloperHome } from '../../../shared/contracts/developer-home.ts';
import { loadSession } from '../console/session.ts';
import type { Island } from '../shell/islands.ts';
import { fetchHome, HomeError } from './api.ts';
import { WorkbenchIsland } from './island.tsx';

/**
 * The `workbench` island in `#workbench` on `/developers`. Signed out, or signed in without developer access, the
 * prerendered home stays as it is. Otherwise the Workbench replaces it: the marketing sections are hidden.
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
  for (const m of document.querySelectorAll<HTMLElement>('[data-home-marketing]')) m.hidden = true;
  createRoot(el).render(<WorkbenchIsland {...(home ? { initial: home } : {})} />);
};
