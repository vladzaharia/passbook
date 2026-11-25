import { QS_COPY } from '../../../shared/copy/developers-quickstart.ts';
import { PATHS } from '../../../shared/developers.ts';
import { loadSession } from '../console/session.ts';
import type { Island } from '../shell/islands.ts';

/**
 * The landing's first button. Held hidden until the session is known (dev-run.css), then it reads "Run in console"
 * for a developer whose sandbox is open. Everyone else keeps "Start the quickstart".
 */
export const mount: Island['mount'] = async (el) => {
  const session = await loadSession();
  if (session.kind !== 'ready') return;
  if (el instanceof HTMLAnchorElement) el.href = PATHS.console;
  el.firstChild?.replaceWith(document.createTextNode(QS_COPY.runInConsole));
};
