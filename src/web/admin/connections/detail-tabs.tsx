import { useMemo, useState } from 'react';
import type { z } from 'zod';
import type { ConnectionDetailSchema } from '@/shared/contracts/connections.ts';
import { ACTION_ICON } from '../../lib/action-icons.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  FormField,
  Input,
  SaveBar,
  toast,
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
} from '../../ui/index.ts';
import { describeSchema, flatFields } from '../passes/schema-form/index.ts';
import { useTemplate } from '../templates/api.ts';
import { useConnectionActions, useConnector } from './api.ts';
import {
  type Lifecycle,
  LifecycleFields,
  lifecycleError,
  lifecycleToPatch,
} from './lifecycle-fields.tsx';
import { fromRows, type MappingRow, type SourceField, toRows } from './mapping.ts';
import { MappingEditor, targetsOf } from './mapping-editor.tsx';
import { TemplateSelect } from './template-select.tsx';

type Detail = z.infer<typeof ConnectionDetailSchema>;

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
  canManage,
  sample,
  onLoadSample,
  loadingSample,
}: {
  c: Detail;
  canManage: boolean;
  sample: readonly SourceField[] | undefined;
  onLoadSample: () => void;
  loadingSample: boolean;
}) {
  const actions = useConnectionActions(c.id);
  const connector = useConnector(c.connectorType, c.orgId);
  const original = useMemo(() => JSON.stringify(c.mapping ?? {}), [c.mapping]);
  const [templateId, setTemplateId] = useState(c.defaultTemplateId ?? '');
  const scope = useOrgScope();
  const templateOrg =
    scope.orgId === c.orgId && scope.membership?.capabilities.includes('templates:read')
      ? c.orgId
      : undefined;
  const template = useTemplate(templateOrg ? templateId || undefined : undefined, templateOrg);
  const [rows, setRows] = useState<MappingRow[]>(() => toRows(c.mapping));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const result = fromRows(rows);
  const dirty =
    JSON.stringify(result.mapping) !== original ||
    Object.keys(result.errors).length > 0 ||
    templateId !== (c.defaultTemplateId ?? '');
  const guard = useUnsavedChangesGuard(canManage && dirty);
  const sources =
    sample ?? Object.keys(connector.data?.outputFields ?? {}).map((k) => ({ pointer: `/${k}` }));

  async function save() {
    if (!canManage) return;
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
      toast.error(error, 'Could not save');
    }
  }

  return (
    <Card>
      <CardHeader
        title="Mapping"
        actions={
          canManage ? (
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
          ) : undefined
        }
      />
      <CardBody className="flex flex-col gap-4">
        <TemplateSelect
          orgId={c.orgId}
          value={templateId}
          disabled={!canManage || !templateOrg || actions.update.isPending}
          onChange={setTemplateId}
        />
        <MappingEditor
          rows={rows}
          onChange={setRows}
          errors={errors}
          targets={
            templateOrg &&
            template.data &&
            (template.data.orgId === null || template.data.orgId === c.orgId)
              ? targetsOf(flatFields(describeSchema(template.data.inputSchema)))
              : []
          }
          sources={sources}
          disabled={!canManage || actions.update.isPending}
        />
      </CardBody>
      {canManage ? (
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
      ) : null}
      <UnsavedChangesDialog blocker={guard} />
    </Card>
  );
}

export function SettingsTab({
  c,
  canManage,
  onSaved,
}: {
  c: Detail;
  canManage: boolean;
  onSaved?: () => void;
}) {
  const actions = useConnectionActions(c.id);
  const connector = useConnector(c.connectorType, c.orgId);
  const initial = useMemo(() => lifecycleOf(c), [c]);
  const [name, setName] = useState(c.name);
  const [life, setLife] = useState<Lifecycle>(initial);
  const [showError, setShowError] = useState(false);
  const dirty = name !== c.name || JSON.stringify(life) !== JSON.stringify(initial);
  const guard = useUnsavedChangesGuard(canManage && dirty);
  const error = lifecycleError(life);
  const defaults = connector.data?.defaults;

  async function save() {
    if (!canManage) return;
    if (error || !name.trim()) return setShowError(true);
    try {
      await actions.update.mutateAsync({ name: name.trim(), ...lifecycleToPatch(life) });
      setShowError(false);
      onSaved?.();
      toast.success('Settings saved');
    } catch (cause) {
      toast.error(cause, 'Could not save');
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
              disabled={!canManage || actions.update.isPending}
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
          disabled={!canManage || actions.update.isPending}
          error={showError ? error : undefined}
        />
      </CardBody>
      {canManage ? (
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
      ) : null}
      <UnsavedChangesDialog blocker={guard} />
    </Card>
  );
}
