import {
  type AnchorHTMLAttributes,
  type ComponentType,
  createContext,
  type ReactNode,
  type Ref,
  useContext,
} from 'react';
import type { Mode } from '@/shared/contracts/common.ts';
import type { PassDetailDto } from '@/shared/contracts/passes.ts';
import type { ReleaseResult } from '@/shared/contracts/template-release-flow.ts';
import {
  type ToolApi,
  ToolScopeProvider,
  useToolApi,
  useToolMode,
} from '../../../lib/tool-api.tsx';
import type { Crumb } from '../../../ui/index.ts';
import type { Template } from '../versions.ts';
import type { CreateDesign } from './create-flow.ts';

/**
 * The one pass designer runs in three hosts: admin (today's page), the Workbench (an org's Test,
 * on the Workbench token) and anonymous (blueprints signed out). The core reaches its host only
 * through this contract; `boundary.test.ts` keeps admin scope, the router and the session client
 * out of everything but `admin/**`.
 */
export type DesignerHostKind = 'admin' | 'workbench' | 'anonymous';

/** Places the designer links to. Each host decides where they live, or that they are text. */
export type DesignerPlace =
  /** The template's own page: the way back from a phone. */
  | { to: 'template'; templateId: string }
  /** Where the template's wallet channels and brand change. */
  | { to: 'channels'; templateId: string }
  /** Where scanning zones are made. */
  | { to: 'zones' };

/** An anchor's props, so a link can sit inside `Button asChild`. */
export type DesignerLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  place: DesignerPlace;
  ref?: Ref<HTMLAnchorElement>;
};

export interface DesignerAllows {
  /** Save version, Create template and kept drafts. */
  save: boolean;
  /** The release step can reach Live (admin with `templates:publish`). */
  publishLive: boolean;
}

/** The header's next release step and the dialogs it opens. */
export interface ReleaseStep {
  action: ReactNode;
  dialog: ReactNode;
}

export interface IssueTestInput {
  templateId: string;
  input: Record<string, unknown>;
  holderEmail?: string | undefined;
}

export interface DesignerHost {
  kind: DesignerHostKind;
  orgId: string | undefined;
  /** Shown beside the logo on the card, as an issued pass shows it. */
  orgName: string | undefined;
  /** Every call is in this mode. The Workbench and anonymous hosts are Test. */
  mode: Mode;
  api: ToolApi;
  allows: DesignerAllows;
  Link: ComponentType<DesignerLinkProps>;
  crumbs: (at: { templateId: string; name: string; create: CreateDesign | undefined }) => Crumb[];
  /**
   * The header's release step. A hook: a host keeps one implementation for its whole life, so the
   * call order never changes.
   */
  useReleaseStep: (templateId: string, template: Template | undefined) => ReleaseStep | null;
  /** Release a saved version, Test only (the Workbench). Admin releases through its dialogs. */
  release?: (templateId: string, version: string) => Promise<ReleaseResult>;
  /** Issue a Test pass from the template's Test release. */
  issueTest?: (input: IssueTestInput) => Promise<PassDetailDto>;
}

const HostContext = createContext<DesignerHost | null>(null);

/**
 * Mounts a host. The Workbench and anonymous hosts pin the client, mode and org for the shared
 * tools under it too; admin's already are the defaults (the session, the switch, the URL).
 */
export function DesignerHostProvider({
  host,
  children,
}: {
  host: DesignerHost;
  children: ReactNode;
}) {
  return (
    <HostContext.Provider value={host}>
      {host.kind === 'admin' ? (
        children
      ) : (
        <ToolScopeProvider api={host.api} mode={host.mode} orgId={host.orgId}>
          {children}
        </ToolScopeProvider>
      )}
    </HostContext.Provider>
  );
}

/** A place's address in admin. The Workbench opens it there in Test; it works from anywhere. */
export function adminHref(place: DesignerPlace, query: Record<string, string> = {}): string {
  const path =
    place.to === 'zones'
      ? '/admin/scanning'
      : `/admin/templates/${encodeURIComponent(place.templateId)}`;
  const tab = place.to === 'zones' ? 'zones' : place.to === 'channels' ? 'channels' : undefined;
  const qs = new URLSearchParams({ ...(tab ? { tab } : {}), ...query }).toString();
  return qs ? `${path}?${qs}` : path;
}

/** A place as text: a host with nowhere to send it (signed out). */
export function PlainLink({ children, className }: DesignerLinkProps) {
  return <span className={className}>{children}</span>;
}

function AdminAddressLink({ place, ...rest }: DesignerLinkProps) {
  return <a href={adminHref(place)} {...rest} />;
}

export const noStep = () => null;

/**
 * A part of the designer rendered on its own (a section in a unit test) has no host. It reads
 * through the surrounding tool scope, links to admin addresses, and cannot save or release.
 */
function useStandaloneHost(): DesignerHost {
  return {
    kind: 'anonymous',
    orgId: undefined,
    orgName: undefined,
    mode: useToolMode(),
    api: useToolApi(),
    allows: { save: false, publishLive: false },
    Link: AdminAddressLink,
    crumbs: () => [],
    useReleaseStep: noStep,
  };
}

export function useDesignerHost(): DesignerHost {
  const host = useContext(HostContext);
  const standalone = useStandaloneHost();
  return host ?? standalone;
}
