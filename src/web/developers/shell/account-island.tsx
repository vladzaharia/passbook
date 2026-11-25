import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { POLARIS_ID_COPY } from '../../../shared/copy/sign-in.ts';
import { personLabel } from '../../lib/format.ts';
import { clearSavedPasses } from '../../lib/saved-passes.ts';
import { ThemeProvider } from '../../lib/theme.tsx';
import { Button } from '../../ui/button.tsx';
import '../../styles/kit-controls.css';
import '../../styles/kit-motion.css';
import { AccountMenu, type SpaceEntry } from '../../ui/layout/account-menu.tsx';
import { POLARIS_START } from './menu-sheet.ts';

export interface MountedUser {
  id: string;
  name: string | null;
  primaryEmail: string | null;
}

/**
 * POST /auth/logout, then wherever it says: the sign-in page or the identity provider's end-session.
 * The SPA's own (lib/session.ts) also clears its caches; this page has none, and importing it would
 * pull the SPA's API client into the site.
 */
async function signOut(csrfToken: string): Promise<void> {
  let target = '/login';
  try {
    const res = await fetch('/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { accept: 'application/json', 'x-csrf-token': csrfToken },
    });
    const body = (await res.json()) as { redirect?: unknown };
    if (typeof body.redirect === 'string' && body.redirect) target = body.redirect;
  } catch {
    // The session is re-checked at /login either way.
  }
  await clearSavedPasses();
  location.assign(target);
}

/** The SPA's account menu on the prerendered site: the same component, mounted over the Sign in link. */
export function mountMenu(
  host: HTMLElement,
  props: {
    user: MountedUser;
    csrfToken: string;
    spaces: SpaceEntry[];
    /** An email-link session: Developers needs Polaris ID, so the way in sits beside the menu. */
    polarisId: boolean;
  },
): () => void {
  const root = createRoot(host);
  // Committed before the slot is shown (shell/islands.ts): Sign in never shows for a frame after the avatar is ready.
  flushSync(() =>
    root.render(
      <ThemeProvider>
        <div className="flex items-center gap-2">
          {props.polarisId ? (
            <Button asChild variant="outline" size="sm" className="dev-polaris">
              <a href={POLARIS_START}>{POLARIS_ID_COPY.signIn}</a>
            </Button>
          ) : null}
          <AccountMenu
            user={props.user}
            label={personLabel(props.user)}
            spaces={props.spaces}
            onSignOut={() => void signOut(props.csrfToken)}
          />
        </div>
      </ThemeProvider>,
    ),
  );
  return () => root.unmount();
}
