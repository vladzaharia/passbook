/**
 * The portal's one browser entry. Pages are prerendered (tools/build-developers.ts), so this only
 * enhances them: copy buttons, the language you chose, the menu, the phone's Try-it bar. Anything
 * heavier is an island, loaded when its placeholder is in view (shell/islands.ts). Keep it small:
 * tools/check-bundle.ts holds the initial load to 60 kB gzip.
 */
import './styles/dev-base.css';
import './styles/dev-layout.css';
import './styles/dev-controls.css';
import './styles/dev-code.css';
import './styles/dev-ticket.css';
import './styles/dev-home.css';
import './styles/dev-reference.css';
import './styles/dev-webhooks.css';
import './styles/dev-changelog.css';
import './styles/dev-run.css';
import './styles/dev-ops.css';
import './styles/dev-responsive.css';
import { initCopy } from './shell/copy.ts';
import { initChangelogFilter } from './shell/filter.ts';
import { mountIslands } from './shell/islands.ts';
import { initLanguage } from './shell/language.ts';
import { initMenu } from './shell/menu.ts';
import { initTryBar } from './shell/try-bar.ts';

initCopy();
initChangelogFilter();
initLanguage();
initMenu();
initTryBar();
mountIslands();
