import { Link } from '@tanstack/react-router';
import { NO_RELEASE_COPY } from '@/shared/copy/new-pass.ts';
import {
  Button,
  Callout,
  ErrorState,
  Form,
  LoadMore,
  PageHeader,
  SkeletonKeyValue,
  SkeletonRows,
  UnsavedChangesDialog,
  Wizard,
} from '../../ui/index.ts';
import { useOrgTimeZone } from '../settings/use-org-time-zone.ts';
import { ShowPassRow, StagePreview } from './new-pass-preview.tsx';
import { ReviewStep } from './new-pass-review.tsx';
import { HolderStep, OrgStep, TemplateStep } from './new-pass-steps.tsx';
import type { NewPassWizardModel } from './new-pass-types.ts';
import { SchemaForm } from './schema-form/index.ts';

const FORM_ID = 'new-pass-step';

const reviewTemplates = (
  <Button asChild size="sm" variant="outline">
    <Link to="/admin/templates">{NO_RELEASE_COPY.action}</Link>
  </Button>
);

const TEMPLATE_NOUN: [string, string] = ['template', 'templates'];

export function NewPassWizardView({ model }: { model: NewPassWizardModel }) {
  const {
    principalId,
    sessionReady,
    templateId,
    setPendingTemplateCommit,
    steps,
    access,
    releaseData,
    draft,
    creation,
    check,
    emailError,
    hiddenKeys,
    go,
    index,
    advance,
    live,
    name,
  } = model;
  const {
    mode,
    scope,
    orgs,
    grantsReady,
    operable,
    active,
    selectedOrg,
    orgId,
    canReadTemplates,
    displayOrgId,
    displayCanReadTemplates,
    displayOrg,
  } = access;
  const orgZone = useOrgTimeZone(orgId ?? undefined);
  const { eligible, usable, selectedTemplate, release, version, releasedVersion, schema } =
    releaseData;
  const {
    input,
    setInput,
    email,
    setEmail,
    send,
    setSend,
    validEmail,
    step,
    at,
    releaseReady,
    readyToCreate,
    createdId,
    guard,
    chooseOrg,
    chooseTemplate,
  } = draft;
  const { payload, create, fieldErrors, onCancel } = creation;
  // Do not render the old draft under a newly confirmed scope while its state is reset.
  if (!scope.isLoading && selectedOrg !== scope.orgId)
    return <SkeletonRows label="Updating organization scope" />;
  // The card the wizard shows is the one the pass's page opens with: the same name morphs it.
  const vt = createdId ? `pass-${createdId}` : undefined;
  // The scope already names the organization: the org step is neither shown nor a way back.
  const skipOrg = Boolean(scope.orgId) && step > 0;
  const shift = skipOrg ? 1 : 0;
  const aside = <StagePreview state={live} name={name} transitionName={vt} />;
  const showPass = <ShowPassRow state={live} title={name ?? 'Pass'} transitionName={vt} />;

  return (
    <>
      <PageHeader
        title="New pass"
        breadcrumbs={[{ label: 'Passes', to: '/admin/passes' }, { label: 'New' }]}
      />
      <Wizard
        steps={skipOrg ? steps.slice(shift) : steps}
        current={step - shift}
        onStep={(i) => go(i + shift)}
        aside={aside}
        onCancel={onCancel}
        {...(step > shift ? { onBack: () => go(step - 1) } : {})}
        formId={FORM_ID}
        nextLabel={
          at === 'review' ? (payload.sendEmail ? 'Create and send' : 'Create pass') : 'Next'
        }
        nextDisabled={
          (at === 'review' && !readyToCreate) ||
          ((at === 'template' || at === 'details' || at === 'holder') && !orgId) ||
          ((at === 'template' || at === 'details') && !canReadTemplates) ||
          (at === 'template' &&
            (!templateId ||
              eligible.isPending ||
              (eligible.isFetching && !eligible.isFetchingNextPage) ||
              (eligible.isError && !eligible.isFetchNextPageError))) ||
          ((at === 'details' || at === 'holder') && !releaseReady)
        }
        busy={create.isPending}
      >
        <Form
          id={FORM_ID}
          {...check.form}
          onValid={advance}
          className="flex min-w-0 flex-col gap-6"
        >
          {at === 'org' ? (
            <OrgStep
              orgs={active}
              loading={scope.isLoading || orgs.isPending}
              error={scope.error ?? orgs.error}
              orgId={selectedOrg}
              choiceError={check.errors.org}
              onSelect={chooseOrg}
              onCommit={(id) => {
                if (!operable.has(id)) return;
                chooseOrg(id);
                go(step + 1);
              }}
            />
          ) : null}
          {at === 'template' ? (
            !displayOrgId ? (
              <Callout tone="warning">Choose an organization where you can issue passes.</Callout>
            ) : !displayCanReadTemplates ? (
              <Callout tone="danger">
                You need permission to view templates for this organization.
              </Callout>
            ) : (
              <>
                <TemplateStep
                  templates={usable}
                  orgId={orgId}
                  orgName={displayOrg?.name}
                  principalId={principalId}
                  mode={mode}
                  loading={
                    scope.isLoading
                      ? usable.length === 0
                      : eligible.isPending || (eligible.isFetching && !eligible.isFetchingNextPage)
                  }
                  error={
                    !scope.isLoading && eligible.isError && !eligible.isFetchNextPageError
                      ? eligible.error
                      : null
                  }
                  hasMore={Boolean(eligible.hasNextPage)}
                  onRetry={() => void eligible.refetch()}
                  templateId={templateId}
                  choiceError={check.errors.template}
                  onSelect={(id) => {
                    if (orgId && canReadTemplates) chooseTemplate(id);
                  }}
                  onCommit={(id) => {
                    if (!orgId || !canReadTemplates) return;
                    chooseTemplate(id);
                    if (id === templateId && release) go(step + 1);
                    else setPendingTemplateCommit(id);
                  }}
                />
                {orgId &&
                canReadTemplates &&
                eligible.data &&
                (!eligible.isError || eligible.isFetchNextPageError) &&
                (!eligible.isFetching || eligible.isFetchingNextPage) &&
                !(scope.isLoading && usable.length === 0) ? (
                  <div className="wl-rise [--wl-delay:240ms]">
                    <LoadMore query={eligible} shown={usable.length} noun={TEMPLATE_NOUN} scoped />
                  </div>
                ) : null}
                {templateId &&
                !scope.isLoading &&
                !selectedTemplate &&
                !eligible.isFetching &&
                !eligible.hasNextPage &&
                eligible.isSuccess ? (
                  <Callout tone="warning" actions={reviewTemplates}>
                    {NO_RELEASE_COPY.template}
                  </Callout>
                ) : null}
              </>
            )
          ) : null}
          {at === 'details' ? (
            !displayOrgId ? (
              <Callout tone="warning">Choose an organization where you can issue passes.</Callout>
            ) : !displayCanReadTemplates ? (
              <Callout tone="danger">
                You need permission to view templates for this organization.
              </Callout>
            ) : !scope.isLoading && eligible.isError && !eligible.isFetchNextPageError ? (
              <ErrorState inline error={eligible.error} onRetry={() => void eligible.refetch()} />
            ) : !scope.isLoading && releasedVersion.isError ? (
              <ErrorState
                inline
                error={releasedVersion.error}
                onRetry={() => void releasedVersion.refetch()}
              />
            ) : !scope.isLoading && !release && !eligible.isFetching ? (
              <Callout tone="warning" actions={reviewTemplates}>
                {NO_RELEASE_COPY.org}
              </Callout>
            ) : !scope.isLoading &&
              release &&
              releasedVersion.isSuccess &&
              releasedVersion.data.version !== version ? (
              <ErrorState
                inline
                title="The server returned a different version than the approved release."
                onRetry={() => void releasedVersion.refetch()}
              />
            ) : !scope.isLoading &&
              release &&
              releasedVersion.isSuccess &&
              !releasedVersion.isFetching &&
              !schema ? (
              <Callout tone="danger">
                The approved release does not provide valid input fields. Choose another template.
              </Callout>
            ) : !release || !schema ? (
              <SkeletonKeyValue label="Loading released fields" />
            ) : (
              <>
                {showPass}
                <SchemaForm
                  orgZone={orgZone}
                  schema={schema}
                  value={input}
                  onChange={setInput}
                  hiddenKeys={hiddenKeys}
                  showAllErrors={Object.values(check.errors).some(Boolean)}
                  serverErrors={fieldErrors}
                />
              </>
            )
          ) : null}
          {at === 'holder' ? (
            <HolderStep
              email={displayCanReadTemplates ? email : ''}
              onEmail={(value) => {
                if (displayCanReadTemplates) setEmail(value);
              }}
              error={displayCanReadTemplates ? emailError : undefined}
              valid={displayCanReadTemplates && validEmail}
              send={displayCanReadTemplates && send}
              onSend={(value) => {
                if (displayCanReadTemplates) setSend(value);
              }}
            />
          ) : null}
          {at === 'review' ? showPass : null}
          {at === 'review' ? (
            <ReviewStep
              org={displayOrg?.name ?? 'Unknown organization'}
              mode={mode}
              template={name}
              setup={{ orgId, templateId, onFixed: live.retry }}
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
              input={input}
              email={displayCanReadTemplates ? email : ''}
              send={displayCanReadTemplates && payload.sendEmail}
              steps={{
                org: index('org'),
                template: index('template'),
                details: index('details'),
                holder: index('holder'),
              }}
              onEdit={go}
              warnings={live.preview?.warnings ?? []}
              error={
                !readyToCreate ? (
                  <Callout tone="danger">
                    {!sessionReady || !grantsReady
                      ? 'Wait until your account and organization permissions are confirmed.'
                      : !orgId
                        ? 'Choose an organization where you can issue passes, then review the pass before creating.'
                        : !canReadTemplates
                          ? 'You need permission to view templates for this organization.'
                          : 'The active release, mode, or version may have changed or is unavailable. Return to a previous step and review the current release before creating.'}
                  </Callout>
                ) : create.isError ? (
                  <Callout tone="danger">
                    {Object.keys(fieldErrors ?? {}).length > 0
                      ? 'Fix the highlighted fields on Details or Holder.'
                      : create.error.message}
                  </Callout>
                ) : null
              }
            />
          ) : null}
        </Form>
      </Wizard>
      <UnsavedChangesDialog blocker={guard} />
    </>
  );
}
