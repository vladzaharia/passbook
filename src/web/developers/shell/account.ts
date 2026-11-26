import { canUseSpace, type SignInMethod, SPACE_HOME, SPACES } from '../../../shared/spaces.ts';
import { loadSession } from '../../workbench/console/session.ts';
import type { MountedUser } from './account-island.tsx';
import { fillMenuSheet, POLARIS_START } from './menu-sheet.ts';

interface SessionBody {
  authenticated?: boolean;
  amr?: SignInMethod;
  roles?: string[];
  consoleGroupRequired?: boolean;
  csrfToken?: string;
  user?: MountedUser;
}

async function get(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    });
    return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
  } catch {
    // Offline or blocked: the bar keeps its signed-out Sign in.
    return null;
  }
}

/**
 * The bar's account menu. The prerendered markup is Sign in; for a signed-in reader this swaps in
 * the SPA's own menu (ui/layout/account-menu.tsx) with the spaces they can use. React and Radix
 * load only then.
 */
export async function mountAccount(host: HTMLElement): Promise<() => void> {
  const me = (await get('/api/v1/session')) as SessionBody | null;
  if (!me?.authenticated || !me.user || !me.amr || !me.csrfToken) return () => {};
  const roles = me.roles ?? [];
  let orgMember = false;
  // Only Polaris ID reaches Admin, so the lookup waits on that.
  if (!roles.includes('admin') && me.amr === 'oidc') {
    const list = (await get('/api/v1/orgs/memberships/me')) as {
      items?: { revokedAt: number | null }[];
    } | null;
    orgMember = list?.items?.some((m) => m.revokedAt === null) === true;
  }
  const access = {
    amr: me.amr,
    roles,
    orgMember,
    consoleGroupRequired: me.consoleGroupRequired,
  };
  const spaces = SPACES.filter((space) => canUseSpace(space, access)).map((space) => ({
    space,
    href: SPACE_HOME[space],
    current: space === 'developers',
  }));
  const polarisId = me.amr === 'magic_link' ? POLARIS_START : null;
  fillMenuSheet(document, { spaces, polarisId });
  // The sandbox's name arrives with its own call; the Spaces group does not wait for it.
  void loadSession().then((session) => {
    if (session.kind === 'ready')
      fillMenuSheet(document, { spaces, polarisId, sandbox: session.sandbox.orgSlug });
  });
  const { mountMenu } = await import('./account-island.tsx');
  return mountMenu(host, {
    user: me.user,
    csrfToken: me.csrfToken,
    spaces,
    polarisId: polarisId !== null,
  });
}
