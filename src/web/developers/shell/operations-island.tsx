import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import '../../../generated/operations-kit.css';
import '../../styles/kit-controls.css';
import '../../styles/kit-motion.css';
import '../../ui/art/scenes/common.css';
import '../../ui/art/scenes/busy.css';
import '../../ui/art/scenes/cheer.css';
import '../../ui/art/scenes/sorry.css';
import { ThemeProvider } from '../../lib/theme.tsx';
import { createFetchClient, OperationsProvider, OperationTray } from '../../ui/operation/index.ts';
import { Toaster } from '../../ui/toaster.tsx';

/**
 * The SPA's tray on the prerendered site. This page has no router and no query cache, so the
 * client is the kit's own fetch client with the session's write token (the account island reads
 * the same session). Importing lib/api.ts here would pull the SPA's API client into the site.
 */
export function mountTray(host: HTMLElement, csrfToken: string): () => void {
  const client = createFetchClient({ csrf: async () => csrfToken });
  const root = createRoot(host);
  flushSync(() =>
    root.render(
      <ThemeProvider>
        <OperationsProvider client={client}>
          <OperationTray notify />
        </OperationsProvider>
        <Toaster belowTopBar />
      </ThemeProvider>,
    ),
  );
  return () => root.unmount();
}
