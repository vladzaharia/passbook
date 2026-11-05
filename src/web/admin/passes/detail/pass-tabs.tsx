import type { UseQueryResult } from '@tanstack/react-query';
import type { PassDetailDto } from '@/shared/contracts/passes.ts';
import type { TemplateDetailSchema } from '@/shared/contracts/templates.ts';
import { ErrorState, SkeletonKeyValue, TabsContent } from '../../../ui/index.ts';
import type { PassActionRunner } from '../pass-actions.tsx';
import { usePassForeign } from '../pass-foreign.ts';
import { ConnectionTab } from './connection-tab.tsx';
import { DeliveryTab } from './delivery-tab.tsx';
import type { Tab } from './detail-page.tsx';
import { DevicesTab } from './devices-tab.tsx';
import { FieldsTab } from './fields-tab.tsx';
import { HolderTab } from './holder-tab.tsx';
import { ImagesTab } from './images-tab.tsx';
import { ActivityTab } from './info-tabs.tsx';
import { SyncTab } from './sync-tab.tsx';
import { VersionsTab } from './versions-tab.tsx';

type Template = UseQueryResult<import('zod').infer<typeof TemplateDetailSchema>>;

/** The tab panels. Fields stays mounted so an unsaved draft survives a look at another tab. */
export function PassTabs({
  pass,
  tab,
  template,
  picked,
  onPick,
  onDraft,
  runner,
}: {
  pass: PassDetailDto;
  tab: Tab;
  template: Template;
  picked: number | undefined;
  onPick: (version: number | undefined) => void;
  onDraft: (draft: Record<string, unknown> | null) => void;
  runner: PassActionRunner;
}) {
  const foreign = usePassForeign(pass);
  return (
    <>
      <TabsContent value="fields" forceMount hidden={tab !== 'fields'}>
        {template.isError ? (
          <ErrorState inline error={template.error} onRetry={() => void template.refetch()} />
        ) : template.data ? (
          <FieldsTab
            key={pass.id}
            pass={pass}
            schema={template.data.inputSchema}
            manifest={template.data.manifest}
            onDraft={onDraft}
            runner={runner}
          />
        ) : (
          <SkeletonKeyValue label="Loading fields" />
        )}
      </TabsContent>
      <TabsContent value="holder">
        <HolderTab pass={pass} foreign={foreign} />
      </TabsContent>
      <TabsContent value="devices" className="min-w-0">
        <DevicesTab pass={pass} active={tab === 'devices'} />
      </TabsContent>
      <TabsContent value="sync" className="min-w-0">
        <SyncTab pass={pass} active={tab === 'sync'} />
      </TabsContent>
      <TabsContent value="delivery" className="min-w-0">
        <DeliveryTab pass={pass} foreign={foreign} />
      </TabsContent>
      <TabsContent value="images">
        <ImagesTab pass={pass} foreign={foreign} />
      </TabsContent>
      <TabsContent value="versions">
        <VersionsTab pass={pass} selected={picked} onSelect={onPick} />
      </TabsContent>
      <TabsContent value="connection">
        <ConnectionTab pass={pass} foreign={foreign} />
      </TabsContent>
      <TabsContent value="activity">
        <ActivityTab passId={pass.id} active={tab === 'activity'} />
      </TabsContent>
    </>
  );
}
