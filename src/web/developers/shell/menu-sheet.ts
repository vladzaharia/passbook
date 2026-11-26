import { DEV_COPY } from '../../../shared/copy/developers.ts';
import { POLARIS_ID_COPY } from '../../../shared/copy/sign-in.ts';
import { PATHS } from '../../../shared/developers.ts';
import type { Space } from '../../../shared/spaces.ts';

/** Email-link sessions: the way in to Developers, beside the menu (the sheet carries it on a phone). */
export const POLARIS_START = `/auth/oidc/start?next=${encodeURIComponent('/developers')}`;

export interface SheetSpace {
  space: Space;
  href: string;
  current: boolean;
}

const LABEL: Partial<Record<Space, string>> = {
  passes: 'My passes',
  admin: 'Admin',
  developers: 'Developers',
};

function heading(text: string): HTMLElement {
  const h = document.createElement('h4');
  h.textContent = text;
  return h;
}

function link(href: string, text: string, current = false): HTMLAnchorElement {
  const a = document.createElement('a');
  a.href = href;
  a.textContent = text;
  if (current) a.setAttribute('aria-current', 'page');
  return a;
}

/**
 * Fills the menu sheet for a signed-in reader: Spaces by the account menu's own rule
 * (`canUseSpace` has already filtered), and Sandbox once there is one. Account stays in the
 * account menu. Signed out, the prerendered Sign in link is all the sheet has.
 */
export function fillMenuSheet(
  root: ParentNode,
  opts: { spaces: readonly SheetSpace[]; sandbox?: string | null; polarisId?: string | null },
): void {
  for (const el of root.querySelectorAll<HTMLAnchorElement>('[data-menu-signin]')) {
    // An email session is signed in but not for Developers: the same slot offers Polaris ID.
    if (opts.polarisId) {
      el.href = opts.polarisId;
      el.textContent = POLARIS_ID_COPY.signIn;
    } else el.hidden = true;
  }
  const spaces = root.querySelector<HTMLElement>('[data-menu-spaces]');
  const shown = opts.spaces.filter((s) => LABEL[s.space]);
  const sandbox = root.querySelector<HTMLElement>('[data-menu-sandbox]');
  if (sandbox && opts.sandbox) {
    const c = DEV_COPY.sheet;
    sandbox.replaceChildren(
      heading(`${c.sandbox} ${opts.sandbox}`),
      link(PATHS.workbench, c.workbench),
      link(PATHS.keys, c.keys),
    );
    sandbox.hidden = false;
  }
  if (spaces && shown.length > 1) {
    const row = document.createElement('div');
    row.className = 'menu-seg';
    for (const s of shown) row.append(link(s.href, LABEL[s.space] ?? '', s.current));
    spaces.replaceChildren(heading(DEV_COPY.sheet.spaces), row);
    spaces.hidden = false;
  }
}
