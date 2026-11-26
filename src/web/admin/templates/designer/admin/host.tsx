import { Link } from '@tanstack/react-router';
import { type ReactNode, useMemo } from 'react';
import { api } from '../../../../lib/api.ts';
import { useMode } from '../../../../lib/mode.ts';
import { useOrgScope } from '../../../../lib/org-filter.tsx';
import { orgPath } from '../../../../lib/scope.ts';
import type { ScanningSearch } from '../../../scanning/search.ts';
import {
  type DesignerHost,
  DesignerHostProvider,
  type DesignerLinkProps,
  useDesignerHost,
} from '../host.tsx';
import { useAdminReleaseStep } from './release-step.tsx';

/** Where an unknown zone gets made; the Zones tab lands with the zones console. */
const ZONES_TAB: ScanningSearch = { tab: 'zones' as ScanningSearch['tab'] };

function AdminLink({ place, ...rest }: DesignerLinkProps) {
  const { orgId } = useDesignerHost();
  if (place.to === 'zones') return <Link to="/admin/scanning" search={ZONES_TAB} {...rest} />;
  return (
    <Link
      to="/admin/templates/$templateId"
      params={{ templateId: place.templateId }}
      search={place.to === 'channels' ? { tab: 'channels' } : { orgId }}
      {...rest}
    />
  );
}

/** Admin's designer: the URL's organization, the session client and the Live/Test switch. */
export function AdminDesignerHost({ children }: { children: ReactNode }) {
  const { orgId, membership } = useOrgScope();
  const mode = useMode();
  const publishLive = membership?.capabilities.includes('templates:publish') ?? false;
  const orgName = membership?.orgName;
  const host = useMemo<DesignerHost>(
    () => ({
      kind: 'admin',
      orgId,
      orgName,
      mode,
      api,
      allows: { save: true, publishLive },
      Link: AdminLink,
      crumbs: ({ templateId, name, create }) =>
        create
          ? [
              { label: 'Blueprints', to: '/admin/blueprints' },
              { label: create.blueprintName, to: `/admin/blueprints/${templateId}` },
              { label: 'New template' },
            ]
          : [
              { label: 'Templates', to: orgId ? orgPath(orgId, '/templates') : undefined },
              { label: name, to: orgId ? orgPath(orgId, `/templates/${templateId}`) : undefined },
              { label: 'Design' },
            ],
      useReleaseStep: useAdminReleaseStep,
    }),
    [orgId, orgName, mode, publishLive],
  );
  return <DesignerHostProvider host={host}>{children}</DesignerHostProvider>;
}
