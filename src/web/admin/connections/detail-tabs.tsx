import { useMemo, useState } from 'react';
import type { z } from 'zod';
import type { ConnectionDetailSchema } from '@/shared/contracts/connections.ts';
import {
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
import { useConnectionActions, useConnector } from './api.ts';
import {
  type Lifecycle,
  LifecycleFields,
  lifecycleError,
  lifecycleToPatch,
} from './lifecycle-fields.tsx';

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
    voidWhen: c.voidWhen,
  };
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
      <CardHeader title="Lifecycle" />
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
