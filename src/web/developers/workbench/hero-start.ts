import { DEV_COPY } from '../../../shared/copy/developers.ts';
import { QS_COPY } from '../../../shared/copy/developers-quickstart.ts';
import { PATHS } from '../../../shared/developers.ts';
import { loadSession } from '../console/session.ts';
import type { Island } from '../shell/islands.ts';

const SANDBOX_HREF = `${PATHS.quickstart}#sandbox`;

function retext(a: HTMLElement, text: string): void {
  const first = a.firstChild;
  if (first?.nodeType === Node.TEXT_NODE) first.textContent = text;
  else a.prepend(document.createTextNode(text));
}

/**
 * The landing's hero follows the session, held in CSS until it is known. Signed in, the workbench card holds the
 * page's one buddy, so the hero's goes; the ticket's button stops saying Sign in; and a developer whose sandbox is
 * open gets "Run in console" first. Everyone else keeps "Start the quickstart".
 */
export const mount: Island['mount'] = async (el) => {
  const session = await loadSession();
  const hero = el.closest('.hero') ?? document;
  const held = [...hero.querySelectorAll<HTMLElement>('[data-hero-try], [data-buddy]')];
  try {
    if (session.kind === 'out' || session.kind === 'failed') return;
    for (const buddy of hero.querySelectorAll('[data-buddy]')) buddy.remove();
    const tryIt = hero.querySelector<HTMLAnchorElement>('[data-hero-try]');
    if (tryIt) {
      tryIt.href = session.kind === 'ready' ? PATHS.console : SANDBOX_HREF;
      tryIt.textContent =
        session.kind === 'ready'
          ? QS_COPY.runInConsole
          : session.kind === 'closed'
            ? DEV_COPY.home.sandboxClosed
            : DEV_COPY.home.sandboxCreate;
    }
    if (session.kind !== 'ready') return;
    if (el instanceof HTMLAnchorElement) el.href = PATHS.console;
    retext(el, QS_COPY.runInConsole);
  } finally {
    for (const node of held) node.dataset.ready = '';
  }
};
