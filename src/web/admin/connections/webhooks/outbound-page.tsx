import { OrgChooser } from '@/web/ui/layout/org-chooser.tsx';
import { useMode } from '../../../lib/mode.ts';
import { useOrgScope } from '../../../lib/org-filter.tsx';
import { OutboundFlow } from './outbound-flow.tsx';

/** The outbound path of the Connections wizard, in the selected organization. */
export function OutboundPage({
  returnTo,
  onBackToPicker,
}: {
  returnTo?: string | undefined;
  onBackToPicker: () => void;
}) {
  const { orgId, membership } = useOrgScope();
  const test = useMode() === 'test';
  if (!orgId) return <OrgChooser />;
  const canManage = Boolean(membership?.capabilities.includes('integrations:manage'));
  return (
    <OutboundFlow
      orgId={orgId}
      canManage={canManage}
      returnTo={returnTo}
      onBackToPicker={test || membership?.testOnly ? undefined : onBackToPicker}
    />
  );
}
