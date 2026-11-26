import {
  type AnchorHTMLAttributes,
  type ComponentType,
  createContext,
  type ReactNode,
  type Ref,
  useContext,
  useMemo,
} from 'react';
import type { z } from 'zod';
import type { Mode } from '@/shared/contracts/common.ts';
import type { PassDetailDto, PassListSchema } from '@/shared/contracts/passes.ts';
import type { ReleaseResult } from '@/shared/contracts/template-release-flow.ts';
import { ApiError } from '../../../lib/errors.ts';
import { type ToolApi, ToolScopeProvider } from '../../../lib/tool-api.tsx';
import type { Crumb } from '../../../ui/index.ts';
import type { Template } from '../versions.ts';
import type { CreateDesign } from './create-flow.ts';

/**
 * The one pass designer runs in three hosts: admin (today's page), the Workbench (an org's Test,
 * on the Workbench token) and anonymous (blueprints signed out). The core reaches its host only
 * through this contract; `boundary.test.ts` keeps admin scope, the router and the session client
 * out of everything but `admin/**`, and `hosts.test.tsx` proves it at runtime.
 */
export type DesignerHostKind = 'admin' | 'workbench' | 'anonymous' | 'standalone';

/** Places the designer links to. Each host decides where they live. */
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
  /** Change the design. Without it the core is read only: no edits, drafts or leave guard. */
  edit: boolean;
  /** Save version and Create template. */
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

export type PassHit = z.infer<typeof PassListSchema>['items'][number];

export interface DesignerHost {
  kind: DesignerHostKind;
  orgId: string | undefined;
  /** Shown beside the logo on the card, as an issued pass shows it. */
  orgName: string | undefined;
  /** Every call is in this mode. The Workbench and anonymous hosts are Test. */
  mode: Mode;
  api: ToolApi;
  /** Bytes of a file the core shows (template assets, branding); it renders object URLs. */
  loadAsset: (path: string, signal?: AbortSignal) => Promise<Blob>;
  /** Passes of the host's org, in its mode, for the Real pass preview. */
  searchPasses: (q: string, signal?: AbortSignal) => Promise<readonly PassHit[]>;
  allows: DesignerAllows;
  /** Null when places lead nowhere (signed out): they show as text. */
  Link: ComponentType<DesignerLinkProps> | null;
  crumbs: (at: { templateId: string; name: string; create: CreateDesign | undefined }) => Crumb[];
  /**
   * The header's release step. A hook: a host keeps one implementation for its whole life, so the
   * call order never changes.
   */
  useReleaseStep: (templateId: string, template: Template | undefined) => ReleaseStep | null;
  /** Release a saved version, Test only (the Workbench). One key per attempt. */
  release?: (templateId: string, version: string, idempotencyKey: string) => Promise<ReleaseResult>;
  /** Issue a Test pass from the template's Test release. */
  issueTest?: (input: IssueTestInput) => Promise<PassDetailDto>;
}

const HostContext = createContext<DesignerHost | null>(null);

/**
 * Mounts a host. The Workbench and anonymous hosts pin the client, mode and org for the shared
 * tools under it too; admin's already are the defaults (the session, the switch, the URL).
 * Hosts are built once (`useMemo`): a new object re-renders every part of the designer.
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
        <ToolScopeProvider
          api={host.api}
          client={`${host.kind}:${host.orgId ?? ''}`}
          mode={host.mode}
          orgId={host.orgId}
        >
          {children}
        </ToolScopeProvider>
      )}
    </HostContext.Provider>
  );
}

const signIn = () =>
  Promise.reject(new ApiError({ status: 401, code: 'unauthorized', detail: 'Sign in to design.' }));

/** No client: every call is refused before it leaves the page. */
export const signedOutApi: ToolApi = {
  get: signIn,
  post: signIn,
  put: signIn,
  patch: signIn,
  deleteJson: signIn,
  delete: signIn,
  action: signIn,
};

/** Fetches a file's bytes; a missing file is an ApiError with its status. */
export async function fetchBytes(path: string, init: RequestInit): Promise<Blob> {
  const res = await fetch(path, init);
  if (!res.ok)
    throw new ApiError({
      status: res.status,
      code: 'asset_unavailable',
      detail: 'A file did not load.',
    });
  return res.blob();
}

/** Admin's route for each place: its router links and `adminHref` both follow this. */
export function adminPlace(
  place: DesignerPlace,
  orgId: string | undefined,
): { path: string; query: Record<string, string> } {
  if (place.to === 'zones') return { path: '/admin/scanning', query: { tab: 'zones' } };
  const path = `/admin/templates/${encodeURIComponent(place.templateId)}`;
  if (place.to === 'channels') return { path, query: { tab: 'channels' } };
  return { path, query: orgId ? { orgId } : {} };
}

/** A place's address in admin, with `extra` query (the Workbench adds its org and Test). */
export function adminHref(
  place: DesignerPlace,
  orgId?: string,
  extra: Record<string, string> = {},
): string {
  const { path, query } = adminPlace(place, orgId);
  const qs = new URLSearchParams({ ...query, ...extra }).toString();
  return qs ? `${path}?${qs}` : path;
}

function AdminAddressLink({ place, ...rest }: DesignerLinkProps) {
  return <a href={adminHref(place)} {...rest} />;
}

export const noStep = () => null;

const noFiles = () =>
  Promise.reject(new ApiError({ status: 404, code: 'asset_unavailable', detail: 'No file.' }));
const noPasses = async () => [];

/**
 * A part of the designer rendered on its own (a section in a unit test) has no host. It has no
 * client, loads no files, links to admin addresses, and cannot edit, save or release.
 */
const STANDALONE: DesignerHost = {
  kind: 'standalone',
  orgId: undefined,
  orgName: undefined,
  mode: 'test',
  api: signedOutApi,
  loadAsset: noFiles,
  searchPasses: noPasses,
  allows: { edit: false, save: false, publishLive: false },
  Link: AdminAddressLink,
  crumbs: () => [],
  useReleaseStep: noStep,
};

export function useDesignerHost(): DesignerHost {
  return useContext(HostContext) ?? STANDALONE;
}

const ADMIN_KEY: readonly string[] = [];

/**
 * Appended to the core's query keys: nothing for admin (its keys stay as they were), else the
 * host's client and mode, so answers never cross hosts. Matches `useToolKey` under the provider.
 */
export function useHostKey(): readonly string[] {
  const { kind, orgId, mode } = useDesignerHost();
  return useMemo(
    () => (kind === 'admin' ? ADMIN_KEY : [`${kind}:${orgId ?? ''}`, mode]),
    [kind, orgId, mode],
  );
}

/** A place as the host links it, or as text when it links nowhere. */
export function PlaceLink(props: DesignerLinkProps) {
  const { Link } = useDesignerHost();
  if (Link) return <Link {...props} />;
  return <span className={props.className}>{props.children}</span>;
}
