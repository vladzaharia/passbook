import { loadSession } from './session.ts';
import { watchSession } from './watch-session.ts';

/**
 * The `console` island, the Console tool of the Workbench. Signed out, the prerendered gate stays as it
 * is and no React loads. Signed in, the bench's code arrives and draws the tool.
 */
export async function mount(el: HTMLElement): Promise<void> {
  watchSession();
  const session = await loadSession();
  if (session.kind === 'out') return;
  el.dataset.state = 'loading';
  const { mountConsole } = await import('./app/mount-console.tsx');
  mountConsole(el, session);
}
