import { useState } from 'react';
import type { WebhookEndpointDto } from '@/shared/contracts/webhooks.ts';
import { isApiError } from '../../../lib/errors.ts';
import {
  Card,
  CardBody,
  CardHeader,
  Form,
  SaveBar,
  toast,
  UnsavedChangesDialog,
  useFormErrors,
  useUnsavedChangesGuard,
} from '../../../ui/index.ts';
import { useEndpointActions } from './api.ts';
import { EndpointFields } from './endpoint-fields.tsx';
import { checkForm, type FormState, formOf, isDirty, patchOf } from './form-state.ts';

/** URL, description, events and templates. A reader sees the masked URL and no controls. */
export function SettingsCard({
  endpoint: e,
  canManage,
}: {
  endpoint: WebhookEndpointDto;
  canManage: boolean;
}) {
  const { update } = useEndpointActions(e.id);
  const [form, setForm] = useState<FormState>(() => formOf(e));
  const [serverUrl, setServerUrl] = useState<string>();
  const dirty = canManage && isDirty(form, e);
  const guard = useUnsavedChangesGuard(dirty);
  const found = checkForm(form);
  const check = useFormErrors(found);

  async function save() {
    try {
      await update.mutateAsync(patchOf(form, e));
      setServerUrl(undefined);
      check.reset();
      toast.success('Saved');
      return 'saved' as const;
    } catch (error) {
      if (isApiError(error) && error.status === 422) {
        setServerUrl(error.message);
        return 'refused' as const;
      }
      toast.error(error, 'Could not save');
      return 'failed' as const;
    }
  }

  return (
    <Card>
      <CardHeader title="Settings" />
      <CardBody>
        <Form
          id="webhook-settings"
          {...check.form}
          invalid={check.form.invalid || Boolean(serverUrl)}
          onValid={save}
        >
          <EndpointFields
            value={form}
            onChange={(p) => {
              setForm((f) => ({ ...f, ...p }));
              if (p.url !== undefined) setServerUrl(undefined);
            }}
            errors={{ ...check.errors, ...(serverUrl ? { url: serverUrl } : {}) }}
            disabled={!canManage}
            masked={e.urlMasked}
            orgId={e.orgId}
          />
        </Form>
      </CardBody>
      {canManage ? (
        <SaveBar
          dirty={dirty}
          saving={update.isPending}
          paused={update.isPaused}
          formId="webhook-settings"
          onDiscard={() => {
            setForm(formOf(e));
            setServerUrl(undefined);
            check.reset();
          }}
        />
      ) : null}
      <UnsavedChangesDialog blocker={guard} />
    </Card>
  );
}
