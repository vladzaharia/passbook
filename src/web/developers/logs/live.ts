import { LOGS_COPY } from '../../../shared/copy/developers-ops.ts';
import { h } from './dom.ts';

/** How often the log asks for newer calls while the tab is in view. Reading the log is never logged itself. */
export const POLL_MS = 4000;
/** Ten quiet minutes and it stops asking; Resume starts it again. */
export const IDLE_MS = 10 * 60_000;

interface Listener {
  /** The "Listening" mark for the page header. */
  el: HTMLElement;
  /** A new call arrived: the quiet clock starts over. */
  heard(): void;
  stop(): void;
}

/**
 * Asks `tick` every few seconds while the page is visible, pauses while it is hidden, and stops after ten quiet
 * minutes. The mark says which, and a tick that lands gives the dot one short blink (none under reduced motion).
 * It ends for good once `host` has left the page.
 */
export function listen(tick: () => Promise<void>, host: Element): Listener {
  const dot = h('span', { class: 'logs-dot', 'aria-hidden': 'true' });
  const label = h('span', {}, LOGS_COPY.live.on);
  const resume = h(
    'button',
    { type: 'button', class: 'logs-resume', hidden: true },
    LOGS_COPY.live.resume,
  );
  const el = h('p', { class: 'logs-live xs', 'data-state': 'on' }, dot, label, resume);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let quietSince = Date.now();
  let stopped = false;

  const state = (s: 'on' | 'paused') => {
    el.dataset.state = s;
    label.textContent = s === 'on' ? LOGS_COPY.live.on : LOGS_COPY.live.paused;
    resume.hidden = s === 'on' || document.visibilityState !== 'visible';
  };
  const schedule = () => {
    clearTimeout(timer);
    if (!stopped) timer = setTimeout(() => void run(), POLL_MS);
  };
  async function run() {
    if (stopped) return;
    if (!host.isConnected) return api.stop();
    if (document.visibilityState !== 'visible') return state('paused');
    if (Date.now() - quietSince > IDLE_MS) return state('paused');
    state('on');
    try {
      await tick();
      dot.classList.remove('blink');
      // A reflow restarts the blink on the same element.
      void dot.offsetWidth;
      dot.classList.add('blink');
    } finally {
      schedule();
    }
  }
  const wake = () => {
    if (document.visibilityState !== 'visible' || stopped) return;
    if (Date.now() - quietSince > IDLE_MS) return state('paused');
    state('on');
    void run();
  };
  resume.addEventListener('click', () => {
    quietSince = Date.now();
    wake();
  });
  document.addEventListener('visibilitychange', wake);
  const api: Listener = {
    el,
    heard: () => {
      quietSince = Date.now();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', wake);
    },
  };
  schedule();
  return api;
}
