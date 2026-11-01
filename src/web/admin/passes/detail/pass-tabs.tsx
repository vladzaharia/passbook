import type { UseQueryResult } from '@tanstack/react-query';
import type { PassDetailDto } from '@/shared/contracts/passes.ts';
import type { TemplateDetailSchema } from '@/shared/contracts/templates.ts';
import { ErrorState, SkeletonKeyValue, TabsContent } from '../../../ui/index.ts';
import { ConnectionTab } from './connection-tab.tsx';
import { DeliveryTab } from './delivery-tab.tsx';
import type { Tab } from './detail-page.tsx';
import { FieldsTab } from './fields-tab.tsx';
import { HolderTab } from './holder-tab.tsx';
import { ImagesTab } from './images-tab.tsx';
import { ActivityTab } from './info-tabs.tsx';
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
}: {
  pass: PassDetailDto;
  tab: Tab;
  template: Template;
  picked: number | undefined;
  onPick: (version: number | undefined) => void;
  onDraft: (draft: Record<string, unknown> | null) => void;
}) {
  return (
    <>
      <TabsContent value="fields" forceMount hidden={tab !== 'fields'}>
        {template.isError ? (
          <ErrorState error={template.error} onRetry={() => void template.refetch()} />
        ) : template.data ? (
          <FieldsTab
            key={pass.id}
            pass={pass}
            schema={template.data.inputSchema}
            manifest={template.data.manifest}
            onDraft={onDraft}
          />
        ) : (
          <SkeletonKeyValue label="Loading fields" />
        )}
      </TabsContent>
      <TabsContent value="holder">
        <HolderTab pass={pass} />
      </TabsContent>
      <TabsContent value="delivery" className="min-w-0">
        <DeliveryTab pass={pass} />
      </TabsContent>
      <TabsContent value="images">
        <ImagesTab pass={pass} />
      </TabsContent>
      <TabsContent value="versions">
        <VersionsTab pass={pass} selected={picked} onSelect={onPick} />
      </TabsContent>
      <TabsContent value="connection">
        <ConnectionTab pass={pass} />
      </TabsContent>
      <TabsContent value="activity">
        <ActivityTab passId={pass.id} active={tab === 'activity'} />
      </TabsContent>
    </>
  );
}
