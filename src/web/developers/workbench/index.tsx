import { createRoot } from 'react-dom/client';
import '../../ui/art/scenes/common.css';
import '../../ui/art/scenes/wave.css';
import './workbench.css';
import './workbench-cards.css';
import { loadSession } from '../console/session.ts';
import type { Island } from '../shell/islands.ts';
import { WorkbenchIsland } from './island.tsx';

/**
 * The `workbench` island: the signed-in developer's home. Signed out, the prerendered page stays as it is.
 * Mount it on `/developers` with `<div data-island="workbench">` and a loader in shell/islands.ts.
 */
export const mount: Island['mount'] = async (el) => {
  const session = await loadSession();
  if (session.kind === 'out') return;
  createRoot(el).render(<WorkbenchIsland />);
};
