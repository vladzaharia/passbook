import { DEV_COPY } from '../../../shared/copy/developers.ts';
import { WB_HOME } from '../../../shared/workbench.ts';

/**
 * The bar's companion link opens Quickstart for a signed-out reader. A signed-in reader goes to the
 * last context's Home (the Workbench picks it), and one who came from the Workbench (`from=workbench`)
 * reads "Back to Workbench".
 */
export function pointWorkbenchLink(signedIn: boolean, root: ParentNode = document): void {
  const back = new URLSearchParams(location.search).get('from') === 'workbench';
  if (!signedIn && !back) return;
  for (const a of root.querySelectorAll<HTMLAnchorElement>('[data-wb-link]')) {
    a.href = WB_HOME;
    const label = a.querySelector('[data-wb-label]');
    if (back && label) label.textContent = DEV_COPY.companion.back;
  }
}
