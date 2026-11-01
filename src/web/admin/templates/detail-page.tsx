import { useNavigate } from '@tanstack/react-router';
import { Archive, Copy, Lock, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { z } from 'zod';
import type { TemplateDetailSchema } from '@/shared/contracts/templates.ts';
import { useOrgOptions } from '../../lib/search.ts';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  Dialog,
  DialogContent,
  ErrorState,
  FormField,
  Input,
  JsonViewer,
  KeyValue,
  PageHeader,
  Select,
  Skeleton,
  StatusPill,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
} from '../../ui/index.ts';
import { PassPreviewPanel } from '../passes/pass-preview.tsx';
import { useTemplate, useTemplateActions, useTemplatePreview } from './api.ts';
import { ManifestEditor } from './manifest-editor.tsx';
import { OrgPanel } from './org-panel.tsx';
import { VersionsPanel } from './versions-panel.tsx';

type Template = z.infer<typeof TemplateDetailSchema>;

function ClonePanel({
  template,
  open,
  onOpenChange,
}: {
  template: Template;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const orgs = useOrgOptions(open);
  const actions = useTemplateActions(template.id);
  const navigate = useNavigate();
  const [orgId, setOrgId] = useState<string>();
  const [name, setName] = useState(`${template.name} copy`);
  const [error, setError] = useState<string>();

  async function clone() {
    if (!orgId) return setError('Choose an organization.');
    try {
      const copy = await actions.clone.mutateAsync({ orgId, name: name.trim() || undefined });
      toast.success('Template cloned');
      onOpenChange(false);
      void navigate({ to: `/admin/templates/${copy.id}` as never });
    } catch (cause) {
      toast.error(cause);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="sm"
        title="Clone template"
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button loading={actions.clone.isPending} onClick={() => void clone()}>
              Clone
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          <FormField label="Organization" required error={error}>
            {(c) => (
              <Select
                {...c}
                value={orgId}
                onValueChange={(v) => {
                  setOrgId(v);
                  setError(undefined);
                }}
                options={(orgs.data?.items ?? []).map((o) => ({ value: o.id, label: o.name }))}
              />
            )}
          </FormField>
          <FormField label="Name">
            {(c) => <Input {...c} value={name} onChange={(e) => setName(e.target.value)} />}
          </FormField>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function TemplateDetailPage({ templateId }: { templateId: string }) {
  const navigate = useNavigate();
  const template = useTemplate(templateId);
  const preview = useTemplatePreview(templateId);
  const actions = useTemplateActions(templateId);
  const [clone, setClone] = useState(false);
  const [remove, setRemove] = useState(false);
  const crumbs = [
    { label: 'Templates', to: '/admin/templates' },
    { label: template.data?.name ?? 'Template' },
  ];

  if (template.isError) {
    return (
      <>
        <PageHeader title="Template" breadcrumbs={crumbs} />
        <ErrorState error={template.error} onRetry={() => void template.refetch()} />
      </>
    );
  }
  if (!template.data) {
    return (
      <>
        <PageHeader title="Template" breadcrumbs={crumbs} />
        <Skeleton className="h-64 w-full" />
      </>
    );
  }
  const t = template.data;
  const baked = t.origin === 'baked';
  const archives = t.passCount > 0;

  return (
    <>
      <PageHeader
        title={t.name}
        breadcrumbs={crumbs}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            {baked ? (
              <Badge tone="accent">
                <Lock aria-hidden />
                Baked
              </Badge>
            ) : (
              <Badge>Uploaded</Badge>
            )}
            <StatusPill status={t.status} tone={t.status === 'active' ? 'success' : 'neutral'} />
            {t.description}
          </span>
        }
        actions={
          <>
            <Button
              variant="outline"
              iconStart={<Copy aria-hidden />}
              onClick={() => setClone(true)}
            >
              {baked ? 'Customize' : 'Clone'}
            </Button>
            {baked ? null : (
              <Button
                variant="danger"
                iconStart={archives ? <Archive aria-hidden /> : <Trash2 aria-hidden />}
                onClick={() => setRemove(true)}
              >
                {archives ? 'Archive' : 'Delete'}
              </Button>
            )}
          </>
        }
      />
      <Tabs defaultValue="versions">
        <TabsList aria-label="Template sections">
          <TabsTrigger value="versions">Versions</TabsTrigger>
          <TabsTrigger value="preview">Preview</TabsTrigger>
          <TabsTrigger value="manifest">Manifest</TabsTrigger>
          <TabsTrigger value="inputs">Inputs</TabsTrigger>
        </TabsList>
        <TabsContent value="versions">
          <VersionsPanel template={t} />
        </TabsContent>
        <TabsContent value="preview">
          <Card className="max-w-sm">
            <CardHeader title="Sample" />
            <CardBody>
              {preview.data ? (
                <PassPreviewPanel
                  passJson={preview.data.passJson}
                  assetBaseUrl={preview.data.assetBaseUrl}
                  assetNames={preview.data.assetNames}
                />
              ) : preview.isError ? (
                <ErrorState error={preview.error} onRetry={() => void preview.refetch()} />
              ) : (
                <Skeleton className="h-80 w-full" />
              )}
            </CardBody>
          </Card>
        </TabsContent>
        <TabsContent value="manifest">
          {baked ? (
            <JsonViewer value={t.manifest} label="Manifest" maxHeight="max-h-[32rem]" />
          ) : (
            <ManifestEditor key={t.activeVersion ?? ''} template={t} />
          )}
        </TabsContent>
        <TabsContent value="inputs">
          <div className="grid gap-4">
            <OrgPanel key={t.orgId ?? 'none'} templateId={t.id} orgId={t.orgId} />
            <Card>
              <CardBody>
                <KeyValue
                  items={[
                    { label: 'Slug', value: t.slug, mono: true },
                    { label: 'Styles', value: t.styles.join(', ') },
                    { label: 'Passes', value: String(t.passCount) },
                  ]}
                />
              </CardBody>
            </Card>
            <JsonViewer value={t.inputSchema} label="Input schema" maxHeight="max-h-[32rem]" />
          </div>
        </TabsContent>
      </Tabs>

      <ClonePanel template={t} open={clone} onOpenChange={setClone} />
      <ConfirmDialog
        open={remove}
        onOpenChange={setRemove}
        title={archives ? 'Archive template?' : 'Delete template?'}
        description="Uploaded templates are archived while passes use them and deleted when none do."
        confirmLabel={archives ? 'Archive' : 'Delete'}
        destructive
        onConfirm={async () => {
          await actions.remove.mutateAsync();
          toast.success(archives ? 'Template archived' : 'Template deleted');
          void navigate({ to: '/admin/templates' });
        }}
      />
    </>
  );
}
