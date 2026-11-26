import { Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { createContext, type ReactNode, useContext } from 'react';
import { PageHeader } from '@/web/ui/index.ts';
import type { PageHeaderProps } from '@/web/ui/page-header.tsx';
import type { KeyAccess } from './use-key-access.ts';

/**
 * What a host adds to the shared keys components. Admin supplies none: its pages read the session,
 * the URL and the console's mode. The Workbench pins its org, lists Test keys only and caps what a
 * new key may hold (`WORKBENCH_KEY_SCOPES`, 30 days), the rule the server enforces for a token.
 */
export interface KeysHost {
  /** Where the list lives; a key's page is this path with the key id as the hash. */
  listPath: string;
  /** A link to a key's page. */
  keyLink: (orgId: string | null, id: string, children: ReactNode) => ReactNode;
  /** What a new key may hold: these scopes, at most this many days, a service key, no role. */
  cap: { scopes: readonly string[]; maxDays: number };
  /** Draws the list's primary action in the host's tool head. */
  primary: (action: ReactNode) => ReactNode;
  /** Beside a key's facts (recent calls). */
  aside?: (keyId: string) => ReactNode;
  /** The access the host already knows. */
  access: Extract<KeyAccess, { state: 'ready' }>;
}

const KeysHostContext = createContext<KeysHost | null>(null);
export const KeysHostProvider = KeysHostContext.Provider;
export const useKeysHost = (): KeysHost | null => useContext(KeysHostContext);

/**
 * A page's head. Admin draws its PageHeader. The Workbench's tool head is already on screen, so the
 * list contributes only its primary action to the head's slot, and a key's page a back link and
 * its name.
 */
export function KeysHeader(props: PageHeaderProps) {
  const host = useKeysHost();
  if (!host) return <PageHeader {...props} />;
  const { title, meta, actions, breadcrumbs } = props;
  if (!breadcrumbs?.length) return <>{host.primary(actions)}</>;
  return (
    <header className="mb-4 flex min-w-0 flex-col gap-2">
      <Link
        to={host.listPath}
        className="inline-flex min-h-6 w-fit items-center gap-1 text-sm text-fg-muted hover:text-fg-strong"
      >
        <ArrowLeft aria-hidden className="size-4" />
        Keys
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 tabIndex={-1} className="min-w-0 text-xl font-semibold text-fg-strong">
          {title}
        </h2>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
      {meta ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">{meta}</div>
      ) : null}
    </header>
  );
}
