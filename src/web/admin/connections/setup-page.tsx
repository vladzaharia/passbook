import type { z } from 'zod';
import type { ConnectionDetailSchema } from '@/shared/contracts/connections.ts';
import { detailError, PageHeader, SkeletonDetail } from '../../ui/index.ts';
import { useConnector } from './api.ts';
import { ProviderWizard } from './provider-wizard.tsx';
import { useConnectionSetup } from './setup-api.ts';

type Detail = z.infer<typeof ConnectionDetailSchema>;

/** `/connections/$id/setup`: the provider's side of a webhook connection, resumable from server state. */
export function SetupView({ c, step }: { c: Detail; step?: 'secret' | undefined }) {
  const setup = useConnectionSetup(c.id);
  const connector = useConnector(c.connectorType, c.orgId);
  const recipe = connector.data?.recipes.find((r) => r.id === c.config.recipe);
  const header = (
    <PageHeader
      title={`Set up ${c.name}`}
      breadcrumbs={[
        { label: 'Connections', to: '/admin/connections' },
        { label: c.name, to: `/admin/connections/${c.id}` },
        { label: 'Setup' },
      ]}
    />
  );
  if (setup.isError)
    return detailError(setup, { entity: 'connection', to: '/admin/connections', header });
  if (!setup.data)
    return (
      <>
        {header}
        <SkeletonDetail label="Loading setup" />
      </>
    );
  return (
    <>
      {header}
      <ProviderWizard connection={c} setup={setup.data} sourceLabel={recipe?.label} openAt={step} />
    </>
  );
}
