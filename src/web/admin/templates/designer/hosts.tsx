import { PassDetailSchema } from '@/shared/contracts/passes.ts';
import { ReleaseResultSchema } from '@/shared/contracts/template-release-flow.ts';
import { TemplateReleaseListSchema } from '@/shared/contracts/template-releases.ts';
import { ApiError } from '../../../lib/errors.ts';
import type { ToolApi } from '../../../lib/tool-api.tsx';
import {
  adminHref,
  type DesignerHost,
  type DesignerLinkProps,
  type IssueTestInput,
  noStep,
  PlainLink,
  useDesignerHost,
} from './host.tsx';

const tpl = (templateId: string) => `/api/v1/templates/${encodeURIComponent(templateId)}`;

/** Release `version` to Test only. The server refuses Live for a Workbench token either way. */
export function releaseInTest(api: ToolApi, orgId: string, templateId: string, version: string) {
  return api.post(
    `${tpl(templateId)}/release`,
    ReleaseResultSchema,
    { orgId, version, modes: ['test'] },
    { headers: { 'idempotency-key': crypto.randomUUID() } },
  );
}

/** A Test pass from the template's active Test release, with no email unless one is named. */
export async function issueTestPass(api: ToolApi, orgId: string, request: IssueTestInput) {
  const { templateId, input, holderEmail } = request;
  const { active } = await api.get(`${tpl(templateId)}/releases`, TemplateReleaseListSchema, {
    query: { orgId, mode: 'test', provider: 'apple' },
  });
  if (!active) throw new Error('Release a version in Test first.');
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
  return <a href={adminHref(place, { ...(orgId ? { orgId } : {}), mode: 'test' })} {...rest} />;
}

export interface WorkbenchHostOptions {
  orgId: string;
  orgName?: string | undefined;
  /** The Workbench token client. */
  api: ToolApi;
  Link?: DesignerHost['Link'];
  crumbs?: DesignerHost['crumbs'];
  useReleaseStep?: DesignerHost['useReleaseStep'];
}

/** An org's Test in the Workbench: saves and Test releases on the token; never Live. */
export function workbenchDesignerHost(options: WorkbenchHostOptions): DesignerHost {
  const { orgId, api } = options;
  return {
    kind: 'workbench',
    orgId,
    orgName: options.orgName,
    mode: 'test',
    api,
    allows: { save: true, publishLive: false },
    Link: options.Link ?? TestAdminLink,
    crumbs: options.crumbs ?? (({ name }) => [{ label: 'Design' }, { label: name }]),
    useReleaseStep: options.useReleaseStep ?? noStep,
    release: (templateId, version) => releaseInTest(api, orgId, templateId, version),
    issueTest: (input) => issueTestPass(api, orgId, input),
  };
}

const signIn = () =>
  Promise.reject(new ApiError({ status: 401, code: 'unauthorized', detail: 'Sign in to design.' }));

/** Signed out there is no client: every call is refused before it leaves the page. */
export const signedOutApi: ToolApi = {
  get: signIn,
  post: signIn,
  put: signIn,
  patch: signIn,
  deleteJson: signIn,
  delete: signIn,
  action: signIn,
};

/** Blueprints signed out: the card and its checks, no organization, no save, no issue. */
export const ANONYMOUS_HOST: DesignerHost = {
  kind: 'anonymous',
  orgId: undefined,
  orgName: undefined,
  mode: 'test',
  api: signedOutApi,
  allows: { save: false, publishLive: false },
  Link: PlainLink,
  crumbs: ({ name }) => [{ label: 'Design' }, { label: name }],
  useReleaseStep: noStep,
};
