import {
  Callout,
  Form,
  PageHeader,
  SkeletonRows,
  UnsavedChangesDialog,
  Wizard,
} from '../../ui/index.ts';
import { ShowPassRow, StagePreview } from './new-pass-preview.tsx';
import { ReviewStep } from './new-pass-review.tsx';
import { DetailsBody, TemplateBody } from './new-pass-step-bodies.tsx';
import { HolderStep, OrgStep } from './new-pass-steps.tsx';
import type { NewPassWizardModel } from './new-pass-types.ts';

export function NewPassWizardView({ model }: { model: NewPassWizardModel }) {
  const { wizard: w, access, releaseData, draft, creation, errors, live, name } = model;
  const { scope, orgs, operable, active, selectedOrg, displayCanReadTemplates, displayOrg } =
    access;
  const { release, schema } = releaseData;
  const { email, setEmail, send, setSend, validEmail, createdId, guard, chooseOrg } = draft;
  const { payload, onCancel } = creation;
  // Do not render the old draft under a newly confirmed scope while its state is reset.
  if (!scope.isLoading && selectedOrg !== scope.orgId)
    return <SkeletonRows label="Updating organization scope" />;
  // The card the wizard shows is the one the pass's page opens with: the same name morphs it.
  const vt = createdId ? `pass-${createdId}` : undefined;
  const aside = <StagePreview state={live} name={name} transitionName={vt} />;
  const at = w.id;
  return (
    <>
      <PageHeader
        title="New pass"
        breadcrumbs={[{ label: 'Passes', to: '/admin/passes' }, { label: 'New' }]}
      />
      <Wizard
        {...w.frame}
        aside={aside}
        onCancel={onCancel}
        nextLabel={
          w.primary === 'finish' ? model.finishLabel : w.primary === 'review' ? 'Review' : 'Next'
        }
      >
        <Form {...w.form} className="flex min-w-0 flex-col gap-6">
          {at === 'org' ? (
            <OrgStep
              orgs={active}
              loading={scope.isLoading || orgs.isPending}
              error={scope.error ?? orgs.error}
              orgId={selectedOrg}
              choiceError={errors.org}
              onSelect={chooseOrg}
              onCommit={(id) => {
                if (!operable.has(id)) return;
                chooseOrg(id);
                w.jump('template');
              }}
            />
          ) : null}
          {at === 'template' && !model.settling ? (
            <TemplateBody model={model} onCommit={() => w.jump('details')} />
          ) : null}
          {at === 'details' ? <DetailsBody model={model} /> : null}
          {at === 'holder' ? (
            <HolderStep
              email={displayCanReadTemplates ? email : ''}
              onEmail={(value) => {
                if (displayCanReadTemplates) setEmail(value);
              }}
              error={displayCanReadTemplates ? model.emailError : undefined}
              valid={displayCanReadTemplates && validEmail}
              send={displayCanReadTemplates && send}
              onSend={(value) => {
                if (displayCanReadTemplates) setSend(value);
              }}
            />
          ) : null}
          {at === 'review' ? (
            <ReviewStep
              orgEditable={w.steps.some((s) => s.id === 'org')}
              onEdit={w.go}
              org={displayOrg?.name ?? 'Unknown organization'}
              mode={access.mode}
              template={name}
              setup={{ orgId: access.orgId, templateId: model.templateId, onFixed: live.retry }}
              release={
                release
                  ? {
                      id: release.releaseId,
                      generation: release.releaseGeneration,
                      provider: 'apple',
                    }
                  : undefined
              }
              schema={schema}
              input={draft.input}
              email={displayCanReadTemplates ? email : ''}
              send={displayCanReadTemplates && payload.sendEmail}
              warnings={live.preview?.warnings ?? []}
              preview={<ShowPassRow state={live} title={name ?? 'Pass'} transitionName={vt} />}
              notice={model.notReady ? <Callout tone="danger">{model.notReady}</Callout> : null}
            />
          ) : null}
        </Form>
      </Wizard>
      <UnsavedChangesDialog blocker={guard} />
    </>
  );
}
