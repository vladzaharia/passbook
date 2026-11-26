import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import type { z } from 'zod';
import type { WebhookEndpointCreatedSchema } from '@/shared/contracts/webhooks.ts';
import { OrgChooser } from '@/web/ui/layout/org-chooser.tsx';
import { isApiError } from '../../../lib/errors.ts';
import { useOrgScope } from '../../../lib/org-filter.tsx';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Form,
  PageHeader,
  SecretReveal,
  toast,
  useFormErrors,
} from '../../../ui/index.ts';
import { useAdminTemplateChoices } from './admin-templates.ts';
import { useSecretCalls, useValidateEndpoint } from './api.ts';
import { EndpointFields } from './endpoint-fields.tsx';
import { FocusOnMount } from './focus-on-mount.tsx';
import { checkForm, draftOf, emptyForm, type FormState } from './form-state.ts';
import { endpointHost } from './health.ts';
import { TestSend } from './test-send.tsx';
import { VerifyGuide } from '../../../ui/webhooks/verify-guide.tsx';

const crumbs = [
  { label: 'Connections', to: '/admin/connections', search: { tab: 'webhooks' } },
  { label: 'Add endpoint' },
];

type Created = z.infer<typeof WebhookEndpointCreatedSchema>;

/** Where a refused URL says why: save-time checks name the reason (host not allowed, not found). */
const urlProblem = (error: unknown) =>
  isApiError(error) && error.status === 422 ? error.message : undefined;

export function NewWebhookPage() {
  const navigate = useNavigate();
  const { orgId, membership } = useOrgScope();
  const { create } = useSecretCalls();
  const validateEndpoint = useValidateEndpoint();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [serverUrl, setServerUrl] = useState<string>();
  const [checking, setChecking] = useState(false);
  const [created, setCreated] = useState<Created>();
  const templates = useAdminTemplateChoices(orgId, form.templateMode === 'selected');
  const found = checkForm(form);
  const check = useFormErrors(found);
  const canManage = Boolean(membership?.capabilities.includes('integrations:manage'));
  const patch = (p: Partial<FormState>) => {
    setForm((f) => ({ ...f, ...p }));
    if (p.url !== undefined) setServerUrl(undefined);
  };
  const toList = () =>
    void navigate({ to: '/admin/connections', search: { tab: 'webhooks' }, replace: true });

  if (created) {
    const id = created.endpoint.id;
    return (
      <>
        <PageHeader
          title="Endpoint added"
          breadcrumbs={[crumbs[0] as (typeof crumbs)[0], { label: 'Added' }]}
        />
        <Card className="max-w-2xl">
          <CardHeader title="Signing secret" />
          <CardBody>
            <FocusOnMount label="Signing secret">
              <SecretReveal
                fields={[
                  {
                    label: 'Signing secret',
                    value: created.secret,
                    copyLabel: 'Copy signing secret',
                  },
                ]}
                doneLabel="Done"
                onDone={() =>
                  void navigate({
                    to: '/admin/connections/webhooks/$endpointId',
                    params: { endpointId: id },
                    replace: true,
                  })
                }
              >
                <VerifyGuide />
                <TestSend endpointId={id} host={endpointHost(created.endpoint)} canManage />
              </SecretReveal>
            </FocusOnMount>
          </CardBody>
        </Card>
      </>
    );
  }

  if (!orgId) return <OrgChooser />;

  /** The dry run on blur: the same static and DNS checks as save, nothing written. */
  async function dryRun() {
    if (found.url || found.eventTypes || found.templateIds) return;
    setChecking(true);
    try {
      await validateEndpoint({ ...draftOf(form), orgId });
      setServerUrl(undefined);
    } catch (error) {
      setServerUrl(urlProblem(error));
    } finally {
      setChecking(false);
    }
  }

  async function save() {
    try {
      setSaving(true);
      setCreated(await create({ ...draftOf(form), orgId }));
      check.reset();
      return 'saved' as const;
    } catch (error) {
      setSaving(false);
      const why = urlProblem(error);
      if (why) setServerUrl(why);
      else toast.error(error, 'Could not add the endpoint');
      return 'refused' as const;
    }
  }

  return (
    <>
      <PageHeader title="Add endpoint" breadcrumbs={crumbs} />
      <Card className="max-w-2xl">
        <CardBody>
          <Form
            id="webhook-new"
            {...check.form}
            invalid={check.form.invalid || Boolean(serverUrl)}
            onValid={save}
          >
            <EndpointFields
              value={form}
              onChange={patch}
              errors={{ ...check.errors, ...(serverUrl ? { url: serverUrl } : {}) }}
              disabled={!canManage}
              templates={templates}
              urlHelp="https only. A signing secret is shown once after you add this."
              checking={checking}
              onUrlBlur={() => void dryRun()}
            />
            <div className="mt-6 flex flex-wrap justify-end gap-2">
              <Button variant="outline" type="button" onClick={toList}>
                Cancel
              </Button>
              <Button type="submit" loading={saving} disabled={!canManage}>
                Add endpoint
              </Button>
            </div>
          </Form>
        </CardBody>
      </Card>
    </>
  );
}
