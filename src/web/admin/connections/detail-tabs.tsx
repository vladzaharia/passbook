import { useMemo, useState } from 'react';
import type { z } from 'zod';
import type { ConnectionDetailSchema } from '@/shared/contracts/connections.ts';
import { ACTION_ICON } from '../../lib/action-icons.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  FormField,
  Input,
  SaveBar,
  Select,
  toast,
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
} from '../../ui/index.ts';
import { describeSchema, flatFields } from '../passes/schema-form/index.ts';
import { useTemplate, useTemplates } from '../templates/api.ts';
import { useConnectionActions, useConnector } from './api.ts';
import {
  type Lifecycle,
  LifecycleFields,
  lifecycleError,
  lifecycleToPatch,
} from './lifecycle-fields.tsx';
import { fromRows, type MappingRow, type SourceField, toRows } from './mapping.ts';
import { MappingEditor, targetsOf } from './mapping-editor.tsx';

type Detail = z.infer<typeof ConnectionDetailSchema>;
const NO_TEMPLATE = '__none__';

export function lifecycleOf(c: Detail): Lifecycle {
  return {
    mode: c.mode,
    intervalMinutes: c.intervalSeconds === null ? '' : String(Math.round(c.intervalSeconds / 60)),
    holderEmailField: c.holderEmailField ?? '',
    defaultTemplateId: c.defaultTemplateId ?? '',
    autoCreate: c.autoCreate,
    autoEmail: c.autoEmail,
    onMissing: c.onMissing,
  };
}

/** Template, then source field → template field rows; one SaveBar for both. */
export function MappingTab({
  c,
  sample,
  onLoadSample,
  loadingSample,
}: {
  c: Detail;
  sample: readonly SourceField[] | undefined;
  onLoadSample: () => void;
  loadingSample: boolean;
}) {
  const actions = useConnectionActions(c.id);
  const connector = useConnector(c.connectorType);
  const templates = useTemplates({ orgId: c.orgId });
  const original = useMemo(() => JSON.stringify(c.mapping ?? {}), [c.mapping]);
  const [templateId, setTemplateId] = useState(c.defaultTemplateId ?? '');
  const template = useTemplate(templateId || undefined);
  const [rows, setRows] = useState<MappingRow[]>(() => toRows(c.mapping));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const result = fromRows(rows);
  const dirty =
    JSON.stringify(result.mapping) !== original ||
    Object.keys(result.errors).length > 0 ||
    templateId !== (c.defaultTemplateId ?? '');
  const guard = useUnsavedChangesGuard(dirty);
  const sources =
    sample ?? Object.keys(connector.data?.outputFields ?? {}).map((k) => ({ pointer: `/${k}` }));

  async function save() {
    setErrors(result.errors);
    if (Object.keys(result.errors).length > 0) return;
    try {
      await actions.update.mutateAsync({
        mapping: result.mapping,
        ...(templateId && templateId !== c.defaultTemplateId
          ? { defaultTemplateId: templateId }
          : {}),
      });
      toast.success('Mapping saved');
    } catch (error) {
      toast.error(error);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Mapping"
        actions={
          <Button
            variant="ghost"
            size="sm"
            busy="pulse"
            loading={loadingSample}
            iconStart={<ACTION_ICON.test aria-hidden />}
            onClick={onLoadSample}
          >
            {sample ? 'New sample' : 'Load sample'}
          </Button>
        }
      />
      <CardBody className="flex flex-col gap-4">
        <FormField label="Template">
          {(f) => (
            <Select
              {...f}
              className="sm:max-w-sm"
              value={templateId || NO_TEMPLATE}
              onValueChange={(v) => setTemplateId(v === NO_TEMPLATE ? '' : v)}
              options={[
                { value: NO_TEMPLATE, label: 'None' },
                ...(templates.data?.items ?? []).map((t) => ({ value: t.id, label: t.name })),
              ]}
            />
          )}
        </FormField>
        <MappingEditor
          rows={rows}
          onChange={setRows}
          errors={errors}
          targets={
            template.data ? targetsOf(flatFields(describeSchema(template.data.inputSchema))) : []
          }
          sources={sources}
          disabled={actions.update.isPending}
        />
      </CardBody>
      <SaveBar
        dirty={dirty}
        saving={actions.update.isPending}
        paused={actions.update.isPaused}
        onSave={() => void save()}
        onDiscard={() => {
          setRows(toRows(c.mapping));
          setTemplateId(c.defaultTemplateId ?? '');
          setErrors({});
        }}
      />
      <UnsavedChangesDialog blocker={guard} />
    </Card>
  );
}

export function SettingsTab({ c }: { c: Detail }) {
  const actions = useConnectionActions(c.id);
  const connector = useConnector(c.connectorType);
  const initial = useMemo(() => lifecycleOf(c), [c]);
  const [name, setName] = useState(c.name);
  const [life, setLife] = useState<Lifecycle>(initial);
  const [showError, setShowError] = useState(false);
  const dirty = name !== c.name || JSON.stringify(life) !== JSON.stringify(initial);
  const guard = useUnsavedChangesGuard(dirty);
  const error = lifecycleError(life);
  const defaults = connector.data?.defaults;

  async function save() {
    if (error || !name.trim()) return setShowError(true);
    try {
      await actions.update.mutateAsync({ name: name.trim(), ...lifecycleToPatch(life) });
      setShowError(false);
      toast.success('Settings saved');
    } catch (cause) {
      toast.error(cause);
    }
  }

  return (
    <Card>
      <CardHeader title="Settings" />
      <CardBody className="flex flex-col gap-4">
        <FormField
          label="Name"
          required
          error={showError && !name.trim() ? 'Required.' : undefined}
        >
          {(f) => (
            <Input
              {...f}
              className="sm:max-w-md"
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </FormField>
        <LifecycleFields
          variant="settings"
          capabilities={connector.data?.capabilities}
          defaultMinutes={defaults ? Math.round(defaults.intervalSeconds / 60) : undefined}
          value={life}
          onChange={setLife}
          disabled={actions.update.isPending}
          error={showError ? error : undefined}
        />
      </CardBody>
      <SaveBar
        dirty={dirty}
        saving={actions.update.isPending}
        paused={actions.update.isPaused}
        onSave={() => void save()}
        onDiscard={() => {
          setName(c.name);
          setLife(initial);
          setShowError(false);
        }}
      />
      <UnsavedChangesDialog blocker={guard} />
    </Card>
  );
}
