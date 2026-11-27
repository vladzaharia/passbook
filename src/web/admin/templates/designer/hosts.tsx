import { useMemo } from 'react';
import { ReleaseResultSchema } from '@/shared/contracts/template-release-flow.ts';
import { TemplateReleaseListSchema } from '@/shared/contracts/template-releases.ts';
import { ApiError } from '../../../lib/errors.ts';
import type { ToolApi } from '../../../lib/tool-api.tsx';
import {
  adminHref,
  type DesignerExtras,
  type DesignerHost,
  type DesignerLinkProps,
  fetchBytes,
  type IssueTestInput,
  noStep,
  sharedLoader,
  signedOutApi,
  useDesignerHost,
} from './host.tsx';
import { useWorkbenchReleaseStep } from './workbench-release-step.tsx';

const tpl = (templateId: string) => `/api/v1/templates/${encodeURIComponent(templateId)}`;
const SEARCH_LIMIT = 5;

/**
 * The Workbench token client, as W1's ToolHost builds it: JSON calls on the bearer with no mode
 * header, and the token itself for file bytes. The brand keeps the session client out.
 */
export interface WorkbenchClient {
  readonly kind: 'workbench-token';
  api: ToolApi;
  token: () => Promise<string>;
}

/** Release `version` to Test only, under the caller's key for this attempt. */
export function releaseInTest(
  api: ToolApi,
  orgId: string,
  templateId: string,
  version: string,
  idempotencyKey: string,
) {
  return api.post(
    `${tpl(templateId)}/release`,
    ReleaseResultSchema,
    { orgId, version, modes: ['test'] },
    { headers: { 'idempotency-key': idempotencyKey } },
  );
}

/** Pass contracts are only needed when a pass is issued or searched, not when the designer opens. */
const passContracts = () => import('@/shared/contracts/passes.ts');

/** A Test pass from the template's active Test release, with no email unless one is named. */
export async function issueTestPass(api: ToolApi, orgId: string, request: IssueTestInput) {
  const { templateId, input, holderEmail } = request;
  const { PassDetailSchema } = await passContracts();
  const { active } = await api.get(`${tpl(templateId)}/releases`, TemplateReleaseListSchema, {
    query: { orgId, mode: 'test', provider: 'apple' },
  });
  if (!active)
    throw new ApiError({
      status: 409,
      code: 'no_test_release',
      detail: 'Release a version in Test first.',
    });
  return api.post(
    '/api/v1/passes',
    PassDetailSchema,
    {
      orgId,
      templateId,
      mode: 'test',
      templateVersion: active.version,
      releaseId: active.id,
      releaseGeneration: active.generation,
      input,
      ...(holderEmail ? { holderEmail } : {}),
      sendEmail: false,
    },
    { headers: { 'idempotency-key': crypto.randomUUID() } },
  );
}

/** From the Workbench, a place is admin's page for the same org, in Test. */
function TestAdminLink({ place, ...rest }: DesignerLinkProps) {
  const { orgId } = useDesignerHost();
  const extra: Record<string, string> = { mode: 'test', ...(orgId ? { orgId } : {}) };
  return <a href={adminHref(place, orgId, extra)} {...rest} />;
}

const loaders = new WeakMap<WorkbenchClient, DesignerHost['loadAsset']>();

/** The client's file loader, one per client: the token's session shares what it has already read. */
function loaderOf(client: WorkbenchClient): DesignerHost['loadAsset'] {
  let load = loaders.get(client);
  if (!load) {
    // The token is bound to this browser's session, so the cookie goes too (R1).
    load = sharedLoader(async (path) =>
      fetchBytes(path, {
        headers: { authorization: `Bearer ${await client.token()}` },
        credentials: 'same-origin',
      }),
    );
    loaders.set(client, load);
  }
  return load;
}

export interface WorkbenchHostOptions {
  orgId: string;
  orgName?: string | undefined;
  client: WorkbenchClient;
  /** The Workbench's panels around the core (workbench/design). */
  extras?: DesignerExtras | undefined;
}

/** An org's Test in the Workbench: every call and file carries the token; never Live. */
export function workbenchDesignerHost({
  orgId,
  orgName,
  client,
  extras,
}: WorkbenchHostOptions): DesignerHost {
  const { api } = client;
  return {
    kind: 'workbench',
    orgId,
    orgName,
    mode: 'test',
    api,
    loadAsset: loaderOf(client),
    searchPasses: async (q, signal) =>
      (
        await api.get('/api/v1/passes', (await passContracts()).PassListSchema, {
          query: { q, orgId, limit: SEARCH_LIMIT },
          ...(signal ? { signal } : {}),
        })
      ).items,
    allows: { edit: true, save: true, publishLive: false },
    Link: TestAdminLink,
    crumbs: ({ name }) => [{ label: 'Design' }, { label: name }],
    useReleaseStep: useWorkbenchReleaseStep,
    release: (templateId, version, key) => releaseInTest(api, orgId, templateId, version, key),
    issueTest: (input) => issueTestPass(api, orgId, input),
    ...(extras ? { extras } : {}),
  };
}

/** The Workbench host, built once per org and client. */
export function useWorkbenchDesignerHost({ orgId, orgName, client, extras }: WorkbenchHostOptions) {
  return useMemo(
    () => workbenchDesignerHost({ orgId, orgName, client, extras }),
    [orgId, orgName, client, extras],
  );
}

/** A blueprint's own files by name, as the anonymous page bundles them. */
export type BundledFiles = Readonly<Record<string, Blob>>;

const fileName = (path: string) => {
  const last = path.split('?')[0]?.split('/').pop() ?? '';
  return decodeURIComponent(last);
};

/** Blueprints signed out: read only, no client, files from the blueprint's own bundle. */
export function anonymousDesignerHost(files: BundledFiles): DesignerHost {
  return {
    kind: 'anonymous',
    orgId: undefined,
    orgName: undefined,
    mode: 'test',
    api: signedOutApi,
    loadAsset: async (path) => {
      const file = files[fileName(path)];
      if (!file) throw new ApiError({ status: 404, code: 'asset_unavailable', detail: 'No file.' });
      return file;
    },
    searchPasses: async () => [],
    allows: { edit: false, save: false, publishLive: false },
    Link: null,
    crumbs: ({ name }) => [{ label: 'Design' }, { label: name }],
    useReleaseStep: noStep,
  };
}

/** The anonymous host, built once per bundle. */
export function useAnonymousDesignerHost(files: BundledFiles) {
  return useMemo(() => anonymousDesignerHost(files), [files]);
}
