/**
 * The portal's one browser entry. Pages are prerendered (tools/build-developers.ts), so this only
 * enhances them: copy buttons, the language you chose, the menu, the phone's Try-it bar. Anything
 * heavier is an island, loaded when its placeholder is in view (shell/islands.ts). Keep it small:
 * tools/check-bundle.ts holds the initial load to 60 kB gzip.
 */
import './styles/dev-base.css';
import '../../generated/menubar-kit.css';
import './styles/dev-layout.css';
import './styles/dev-frame.css';
import './styles/dev-frame-page.css';
import './styles/dev-controls.css';
import './styles/dev-code-head.css';
import './styles/dev-code.css';
import './styles/dev-code-extras.css';
import './styles/dev-ticket.css';
import './styles/dev-home.css';
import './styles/dev-reference.css';
import './styles/dev-webhooks.css';
import './styles/dev-changelog.css';
import './styles/dev-run.css';
import './styles/org-chip.css';
import './styles/dev-ops.css';
import './styles/dev-guide.css';
import './styles/dev-quickstart-card.css';
import './styles/dev-quickstart.css';
import './styles/dev-responsive.css';
import '../ui/art/scenes/common.css';
import '../ui/art/scenes/plug.css';
import './ui/gate.css';
import './ui/state-card.css';
import { PATHS } from '../../shared/developers.ts';
import { markViewed } from './quickstart/viewed.ts';
import { initCopy } from './shell/copy.ts';
import { initChangelogFilter } from './shell/filter.ts';
import { mountIslands } from './shell/islands.ts';
import { initLanguage } from './shell/language.ts';
import { initMenu } from './shell/menu.ts';
import { initSearch } from './shell/search.ts';
import { initTryBar } from './shell/try-bar.ts';

if (location.pathname.replace(/\/+$/, '') === PATHS.quickstart) markViewed();
initCopy();
initChangelogFilter();
initLanguage();
initMenu();
initSearch();
initTryBar();
mountIslands();
// "On this page" shows from 1280 px: only then is its chunk fetched, once.
const wide = matchMedia('(min-width: 1280px)');
const loadToc = () =>
  import('./shell/toc.ts').then((t) => t.initToc()).catch((error) => reportError(error));
if (document.querySelector('[data-toc]')) {
  if (wide.matches) void loadToc();
  else wide.addEventListener('change', (e) => e.matches && void loadToc(), { once: true });
}
