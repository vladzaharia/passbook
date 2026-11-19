import { Link } from '@tanstack/react-router';
import { Printer } from 'lucide-react';
import { useState } from 'react';
import { HOLDER_COPY } from '@/shared/copy/holder.ts';
import { JOIN_COPY } from '@/shared/copy/join.ts';
import { isApiError } from '../../../lib/errors.ts';
import { useMode } from '../../../lib/mode.ts';
import { useOrgScope } from '../../../lib/org-filter.tsx';
import { initialsOf } from '../../../ui/entity.tsx';
import {
  Button,
  DetailNotFound,
  detailError,
  EmptyState,
  PageHeader,
  Skeleton,
} from '../../../ui/index.ts';
import { useOrgWorkspace } from '../../orgs/queries.ts';
import { useTemplate } from '../api.ts';
import { useJoinLink } from './api.ts';
import { useJoinQr } from './join-qr.ts';
import './join-sign.css';
import { orgPath } from '../../../lib/scope.ts';

/** The org's logo from its branding (a stored image), else its initials on the sign's blue. No logo is never requested. */
function Logo({ orgId, name, hasLogo }: { orgId: string; name: string; hasLogo: boolean }) {
  const [missing, setMissing] = useState(false);
  return (
    <span className="jl-logo" aria-hidden="true">
      {missing || !hasLogo ? (
        initialsOf(name)
      ) : (
        <img
          src={`/api/v1/orgs/${encodeURIComponent(orgId)}/branding/logo`}
          alt=""
          onError={() => setMissing(true)}
        />
      )}
    </span>
  );
}

/** The A5 sign: org, the QR, "Get your card", how, and the short link. No buddy: it is for print. */
export function JoinSign({
  orgId,
  orgName,
  url,
  hasLogo,
}: {
  orgId: string;
  orgName: string;
  url: string;
  hasLogo: boolean;
}) {
  const qr = useJoinQr(url);
  return (
    <section className="jl-paper" aria-label={JOIN_COPY.sign.crumb}>
      <div className="jl-org">
        <Logo orgId={orgId} name={orgName} hasLogo={hasLogo} />
        <span>{orgName}</span>
      </div>
      <div className="jl-code">
        {qr.src ? (
          <img src={qr.src} alt={`QR code for ${url}`} />
        ) : qr.failed ? (
          <span role="alert">{HOLDER_COPY.qrFailed}</span>
        ) : (
          <span role="img" aria-label="QR code" aria-busy="true" />
        )}
      </div>
      <h2>{JOIN_COPY.sign.title}</h2>
      <p>{JOIN_COPY.sign.scan}</p>
      <code>{url.replace(/^https?:\/\//, '')}</code>
    </section>
  );
}

export function JoinSignPage({ templateId }: { templateId: string }) {
  const scope = useOrgScope();
  const mode = useMode();
  const template = useTemplate(templateId, scope.orgId);
  const platform = template.data?.orgId === null;
  const state = useJoinLink(
    { templateId, orgId: platform ? scope.orgId : undefined, mode },
    Boolean(template.data),
  );
  const org = useOrgWorkspace(scope.orgId ?? '', Boolean(scope.orgId));
  const crumbs = [
    { label: 'Templates', to: orgPath(scope.orgId ?? '', '/templates') },
    {
      label: template.data?.name ?? 'Template',
      to: orgPath(scope.orgId ?? '', `/templates/${encodeURIComponent(templateId)}`),
    },
    { label: JOIN_COPY.sign.crumb },
  ];
  const header = <PageHeader title={JOIN_COPY.sign.crumb} breadcrumbs={crumbs} />;
  if (template.isError)
    return detailError(template, { entity: 'template', to: '/admin/templates', header });
  if (state.isError && isApiError(state.error) && state.error.isNotFound)
    return (
      <>
        {header}
        <DetailNotFound entity="template" to="/admin/templates" />
      </>
    );
  if (state.isError)
    return detailError(state, { entity: 'template', to: '/admin/templates', header });
  const url = state.data?.link?.url ?? null;
  if (!state.data || !template.data || !scope.orgId || org.isLoading)
    return (
      <>
        {header}
        <Skeleton className="mx-auto aspect-[148/210] w-full max-w-90" />
      </>
    );
  if (!url)
    return (
      <>
        {header}
        <EmptyState
          inline
          art="template"
          title={JOIN_COPY.sign.none}
          action={
            <Button variant="outline" asChild>
              <Link
                to="/admin/templates/$templateId"
                params={{ templateId }}
                search={{ orgId: scope.orgId }}
              >
                {JOIN_COPY.sign.back}
              </Link>
            </Button>
          }
        />
      </>
    );
  const orgName =
    scope.memberships.find((m) => m.orgId === scope.orgId)?.orgName ?? template.data.orgName ?? '';
  return (
    <>
      <PageHeader
        title={JOIN_COPY.sign.crumb}
        breadcrumbs={crumbs}
        actions={
          <Button iconStart={<Printer aria-hidden />} onClick={() => window.print()}>
            {JOIN_COPY.sign.print}
          </Button>
        }
      />
      <JoinSign
        orgId={scope.orgId}
        orgName={orgName}
        url={url}
        hasLogo={Boolean(org.data?.branding.logo)}
      />
    </>
  );
}
