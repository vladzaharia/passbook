import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import '../../ui/art/scenes/common.css';
import '../../ui/art/scenes/wave.css';
import './workbench.css';
import './workbench-cards.css';
import type { DeveloperHome } from '../../../shared/contracts/developer-home.ts';
import { QS_COPY } from '../../../shared/copy/developers-quickstart.ts';
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
  runInConsole();
  // Committed before the slot is shown again (shell/islands.ts), so the static card never flashes back.
  const root = createRoot(el);
  flushSync(() => root.render(<WorkbenchIsland {...(home ? { initial: home } : {})} />));
};

/** Signed in, the hero's first button goes to the console: the quickstart is for someone who has not made a sandbox. */
function runInConsole(): void {
  const a = document.querySelector<HTMLAnchorElement>('a[data-hero-start]');
  if (!a) return;
  a.href = PATHS.console;
  a.firstChild?.replaceWith(document.createTextNode(QS_COPY.runInConsole));
}
