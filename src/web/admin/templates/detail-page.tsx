import { useNavigate } from '@tanstack/react-router';
import { Archive, Copy, Lock, MoreHorizontal, Trash2 } from 'lucide-react';
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
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
import { describeSchema, flatFields } from '../passes/schema-form/index.ts';
import { useTemplate, useTemplateActions, useTemplatePreview } from './api.ts';
import { styleList } from './labels.ts';
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

function InputFields({ schema }: { schema: unknown }) {
  const fields = flatFields(describeSchema(schema));
  if (fields.length === 0) return <p className="p-4 text-sm text-fg-muted">No inputs.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Template inputs</caption>
        <thead>
          <tr className="border-b border-border text-fg-muted">
            <th scope="col" className="h-10 px-4 font-medium">
              Name
            </th>
            <th scope="col" className="h-10 px-3 font-medium">
              Label
            </th>
            <th scope="col" className="h-10 px-3 font-medium">
              Type
            </th>
            <th scope="col" className="h-10 px-4 font-medium">
              Required
            </th>
          </tr>
        </thead>
        <tbody>
          {fields.map((f) => (
            <tr key={f.key} className="border-b border-border last:border-b-0">
              <td className="px-4 py-2 font-mono text-xs whitespace-nowrap">{f.key}</td>
              <td className="px-3 py-2 whitespace-nowrap">{f.label}</td>
              <td className="px-3 py-2 whitespace-nowrap text-fg-muted">{f.widget}</td>
              <td className="px-4 py-2 whitespace-nowrap">{f.required ? 'Yes' : 'No'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
        description={t.description ?? undefined}
        meta={
          <>
            {baked ? (
              <Badge tone="accent">
                <Lock aria-hidden />
                Baked
              </Badge>
            ) : (
              <Badge>Uploaded</Badge>
            )}
            <StatusPill status={t.status} tone={t.status === 'active' ? 'success' : 'neutral'} />
          </>
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
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" iconStart={<MoreHorizontal aria-hidden />}>
                    More
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem destructive onSelect={() => setRemove(true)}>
                    {archives ? <Archive aria-hidden /> : <Trash2 aria-hidden />}
                    {archives ? 'Archive' : 'Delete'}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        }
      />
      <Tabs defaultValue="overview" className="min-w-0">
        <TabsList aria-label="Template sections">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="versions">Versions</TabsTrigger>
          <TabsTrigger value="preview">Preview</TabsTrigger>
          <TabsTrigger value="manifest">Manifest</TabsTrigger>
          <TabsTrigger value="inputs">Inputs</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <div className="grid max-w-3xl grid-cols-[minmax(0,1fr)] gap-6">
            <OrgPanel key={t.orgId ?? 'none'} templateId={t.id} orgId={t.orgId} />
            <Card>
              <CardHeader title="Details" />
              <CardBody>
                <KeyValue
                  items={[
                    { label: 'Slug', value: t.slug, mono: true },
                    { label: 'Styles', value: styleList(t.styles) },
                    { label: 'Passes', value: String(t.passCount) },
                  ]}
                />
              </CardBody>
            </Card>
          </div>
        </TabsContent>
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
          <div className="grid max-w-3xl grid-cols-[minmax(0,1fr)] gap-6">
            <Card>
              <CardHeader title="Fields" />
              <InputFields schema={t.inputSchema} />
            </Card>
            <details className="rounded-lg border border-border bg-surface-raised">
              <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-fg-strong">
                Input schema (JSON)
              </summary>
              <div className="border-t border-border p-4">
                <JsonViewer value={t.inputSchema} label="Input schema" maxHeight="max-h-[32rem]" />
              </div>
            </details>
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
