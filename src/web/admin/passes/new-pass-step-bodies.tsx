import { Link } from '@tanstack/react-router';
import { NO_RELEASE_COPY } from '@/shared/copy/new-pass.ts';
import { Button, Callout, ErrorState, LoadMore, SkeletonKeyValue } from '../../ui/index.ts';
import { useOrgTimeZone } from '../settings/use-org-time-zone.ts';
import { ShowPassRow } from './new-pass-preview.tsx';
import { TemplateStep } from './new-pass-steps.tsx';
import type { NewPassWizardModel } from './new-pass-types.ts';
import { SchemaForm } from './schema-form/index.ts';

const TEMPLATE_NOUN: [string, string] = ['template', 'templates'];

const reviewTemplates = (
  <Button asChild size="sm" variant="outline">
    <Link to="/admin/templates">{NO_RELEASE_COPY.action}</Link>
  </Button>
);

const NO_ORG = <Callout tone="warning">Choose an organization where you can issue passes.</Callout>;
const NO_ACCESS = (
  <Callout tone="danger">You need permission to view templates for this organization.</Callout>
);

/** Template: the tiles, and what to do when none is eligible or the chosen one lost its release. */
export function TemplateBody({
  model,
  onCommit,
}: {
  model: NewPassWizardModel;
  onCommit: (id: string) => void;
}) {
  const { principalId, templateId, access, releaseData, draft, errors } = model;
  const {
    mode,
    scope,
    orgId,
    canReadTemplates,
    displayOrgId,
    displayCanReadTemplates,
    displayOrg,
  } = access;
  const { eligible, usable, selectedTemplate, release } = releaseData;
  if (!displayOrgId) return NO_ORG;
  if (!displayCanReadTemplates) return NO_ACCESS;
  return (
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
        choiceError={errors.template}
        onSelect={(id) => {
          if (orgId && canReadTemplates) draft.chooseTemplate(id);
        }}
        onCommit={(id) => {
          if (!orgId || !canReadTemplates) return;
          draft.chooseTemplate(id);
          if (id === templateId && release) onCommit(id);
          else model.setPendingTemplateCommit(id);
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
  );
}

/** Details: the released fields, or why they are not there yet. */
export function DetailsBody({ model }: { model: NewPassWizardModel }) {
  const { access, releaseData, draft, errors, fieldErrors, hiddenKeys, live, name } = model;
  const { scope, orgId, displayOrgId, displayCanReadTemplates } = access;
  const { eligible, release, version, releasedVersion, schema } = releaseData;
  const orgZone = useOrgTimeZone(orgId ?? undefined);
  if (!displayOrgId) return NO_ORG;
  if (!displayCanReadTemplates) return NO_ACCESS;
  if (!scope.isLoading && eligible.isError && !eligible.isFetchNextPageError)
    return <ErrorState inline error={eligible.error} onRetry={() => void eligible.refetch()} />;
  if (!scope.isLoading && releasedVersion.isError)
    return (
      <ErrorState
        inline
        error={releasedVersion.error}
        onRetry={() => void releasedVersion.refetch()}
      />
    );
  if (!scope.isLoading && !release && !eligible.isFetching)
    return (
      <Callout tone="warning" actions={reviewTemplates}>
        {NO_RELEASE_COPY.org}
      </Callout>
    );
  if (
    !scope.isLoading &&
    release &&
    releasedVersion.isSuccess &&
    releasedVersion.data.version !== version
  )
    return (
      <ErrorState
        inline
        title="The server returned a different version than the approved release."
        onRetry={() => void releasedVersion.refetch()}
      />
    );
  if (
    !scope.isLoading &&
    release &&
    releasedVersion.isSuccess &&
    !releasedVersion.isFetching &&
    !schema
  )
    return (
      <Callout tone="danger">
        The approved release does not provide valid input fields. Choose another template.
      </Callout>
    );
  if (!release || !schema) return <SkeletonKeyValue label="Loading released fields" />;
  return (
    <>
      <ShowPassRow
        state={live}
        title={name ?? 'Pass'}
        transitionName={draft.createdId ? `pass-${draft.createdId}` : undefined}
      />
      <SchemaForm
        orgZone={orgZone}
        schema={schema}
        value={draft.input}
        onChange={draft.setInput}
        hiddenKeys={hiddenKeys}
        showAllErrors={Object.entries(errors).some(([k, v]) => k !== 'wait' && Boolean(v))}
        serverErrors={fieldErrors}
      />
    </>
  );
}
