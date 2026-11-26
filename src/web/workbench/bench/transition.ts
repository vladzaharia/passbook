import { TOOL_PATH } from '../../developers/pages/toc.tsx';
import { BENCH_IDS } from './frame.tsx';
import { BENCH_TOOLS } from './switcher.tsx';

/** The tool switch's script, served beside the pages; every bench page loads it before its first paint. */
export const BENCH_VT_FILE = '/developers/bench-vt.js';

/**
 * A cross-document view transition runs only from one tool to another (view-transition.css opts every
 * portal page in, so this skips the rest), and it is typed by tab order: `bench-next` moves the stage
 * in from the right, `bench-back` from the left. The previous page comes from the Navigation API, or
 * the referrer where there is none (Safari before 26.2).
 */
export function benchVtScript(): string {
  const tools = JSON.stringify(BENCH_TOOLS.map((t) => TOOL_PATH[t]));
  return `(() => {
  const tools = ${tools};
  const at = (href) => {
    try {
      return tools.indexOf(new URL(href, location.href).pathname.replace(/\\/+$/, ''));
    } catch {
      return -1;
    }
  };
  addEventListener('pagereveal', (e) => {
    const vt = e.viewTransition;
    if (!vt) return;
    const from = at(self.navigation?.activation?.from?.url ?? document.referrer);
    const to = at(location.href);
    if (from < 0 || to < 0 || from === to) return vt.skipTransition();
    vt.types?.add(to > from ? 'bench-next' : 'bench-back');
  });
})();
`;
}

/** The head of a bench page: the script, and a hold on painting until the head and title are parsed. */
export const BENCH_VT_HEAD =
  `<script async blocking="render" src="${BENCH_VT_FILE}"></script>` +
  `<link rel="expect" href="#${BENCH_IDS.title}" blocking="render">`;
