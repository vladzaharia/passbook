import {
  type MutableRefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { EMAIL_INVALID_MESSAGE } from '@/shared/email.ts';
import { useWizard, type WizardModel, type WizardStepDef } from '../../ui/index.ts';
import type {
  NewPassCreation,
  NewPassDraft,
  NewPassRelease,
  NewPassScope,
  StepId,
} from './new-pass-types.ts';
import { cleanValues, describeSchema } from './schema-form/index.ts';
import { displayName } from './template-groups.ts';

const TITLES: Record<StepId, string> = {
  org: 'Organization',
  template: 'Template',
  details: 'Details',
  holder: 'Holder',
  review: 'Review',
};
const HEADINGS: Record<StepId, string> = {
  org: 'Pick the organization',
  template: 'Pick a template',
  details: 'Fill in the pass',
  holder: 'Who gets it',
  review: 'Check and create',
};
/** The wizard keys the server's field errors by; the details fields are the schema's own. */
const HOLDER_FIELDS = ['holderEmail', 'sendEmail'];

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Why Create is off, or undefined when it is ready. */
export function notReadyReason(input: {
  sessionReady: boolean;
  grantsReady: boolean;
  orgId: string | undefined;
  canReadTemplates: boolean;
  ready: boolean;
}) {
  if (input.ready) return undefined;
  if (!input.sessionReady || !input.grantsReady)
    return 'Wait until your account and organization permissions are confirmed.';
  if (!input.orgId)
    return 'Choose an organization where you can issue passes, then review the pass before creating.';
  if (!input.canReadTemplates)
    return 'You need permission to view templates for this organization.';
  return 'The active release, mode, or version may have changed or is unavailable. Return to a previous step and review the current release before creating.';
}

/**
 * The wizard's steps and where it is. The organization step is in the rail only when the person
 * picks it here: a scope that already names one never shows it.
 */
export function useNewPassNav({
  principalId,
  sessionReady,
  linkTemplate,
  access,
  releaseData,
  draft,
  creation,
  setPendingTemplateCommit,
  pendingTemplateCommit,
  templateId,
  navReset,
  orgFixed,
}: {
  principalId: string | undefined;
  sessionReady: boolean;
  linkTemplate: string | undefined;
  access: NewPassScope;
  releaseData: NewPassRelease;
  draft: NewPassDraft;
  creation: NewPassCreation;
  setPendingTemplateCommit: (id: string | undefined) => void;
  pendingTemplateCommit: string | undefined;
  templateId: string | undefined;
  navReset: MutableRefObject<() => void>;
  orgFixed: boolean;
}): { wizard: WizardModel<StepId>; notReady: string | undefined; settling: boolean } {
  const { mode, scope, orgId, canReadTemplates, grantsReady, displayOrg } = access;
  const { eligible, selectedTemplate, release, version, schema } = releaseData;
  const { input, email, validEmail, inputErrors, releaseReady, readyToCreate, reviewed } = draft;
  const { payload, create } = creation;
  const waiting =
    eligible.isPending || (eligible.isFetching && !eligible.isFetchingNextPage) || eligible.isError;
  const notReady = notReadyReason({
    sessionReady: sessionReady,
    grantsReady,
    orgId,
    canReadTemplates,
    ready: readyToCreate,
  });
  const noAccess = !orgId
    ? 'Choose an organization.'
    : !canReadTemplates
      ? 'No template access.'
      : undefined;
  const ids: StepId[] = orgFixed
    ? ['template', 'details', 'holder', 'review']
    : ['org', 'template', 'details', 'holder', 'review'];
  const filled = Object.keys(cleanValues(input)).length;
  const summary: Partial<Record<StepId, string | undefined>> = {
    org: displayOrg?.name,
    template: selectedTemplate ? displayName(selectedTemplate) : undefined,
    details: filled > 0 ? plural(filled, 'field', 'fields') : undefined,
    holder: email.trim() || 'No holder',
  };
  const steps: WizardStepDef<StepId>[] = ids.map((id) => ({
    id,
    title: TITLES[id],
    heading: HEADINGS[id],
    summary: summary[id],
  }));
  const waitFor = (reason: string | undefined) => (reason ? { wait: reason } : undefined);
  const errors: Partial<Record<StepId, Partial<Record<string, string>>>> = {
    org: orgId ? {} : { org: 'Choose an organization.' },
    template: {
      ...(selectedTemplate ? {} : { template: 'Choose a template.' }),
      ...waitFor(noAccess ?? (templateId && waiting ? 'Loading templates.' : undefined)),
    },
    details: {
      ...inputErrors,
      ...waitFor(noAccess ?? (releaseReady ? undefined : 'Loading the release.')),
    },
    holder: {
      ...(email.trim() && !validEmail ? { holderEmail: EMAIL_INVALID_MESSAGE } : {}),
      ...waitFor(noAccess ?? (releaseReady ? undefined : 'Loading the release.')),
    },
    review: notReady ? { wait: notReady } : {},
  };
  const hints: Partial<Record<StepId, string>> = {};
  for (const id of ids) {
    const found = errors[id] ?? {};
    const keys = Object.keys(found).filter((k) => found[k]);
    const only = keys.length === 1 && keys[0] === 'wait' ? found.wait : undefined;
    if (only) hints[id] = id === 'review' ? 'Not ready to create.' : only;
  }
  const fieldStep = useMemo(() => {
    const out: Partial<Record<string, StepId>> = {};
    for (const f of HOLDER_FIELDS) out[f] = 'holder';
    for (const g of describeSchema(schema))
      for (const f of g.fields) out[`input.${f.key}`] = 'details';
    return out;
  }, [schema]);
  const finish = useRef<() => Promise<unknown>>(async () => undefined);
  finish.current = async () => {
    const {
      orgId: o,
      templateId: t,
      templateVersion: v,
      releaseId: r,
      releaseGeneration: g,
    } = payload;
    if (!principalId || !o || !t || !v?.trim() || !r || g === undefined)
      throw new Error('Review the current approved release before creating.');
    await create.mutateAsync({
      payload: {
        ...payload,
        orgId: o,
        templateId: t,
        templateVersion: v,
        releaseId: r,
        releaseGeneration: g,
      },
      firstOfOrg: draft.firstOfOrg,
      principalId,
    });
  };
  const wizard = useWizard<StepId>({
    steps,
    errors,
    hints,
    fieldStep,
    onFinish: () => finish.current(),
  });
  const at = wizard.id;
  const { jump, reset } = wizard;

  // A new organization starts the wizard over; the rail's first step is this run's own.
  navReset.current = reset;

  // Entering Review pins what was reviewed; the check below unpins it if the release moves.
  const { setReviewed, setConflict } = draft;
  const { reset: resetCreate } = create;
  const wasReview = useRef(false);
  useLayoutEffect(() => {
    const now = at === 'review';
    const entered = now && !wasReview.current;
    wasReview.current = now;
    if (!entered) return;
    setReviewed(
      principalId &&
        orgId &&
        selectedTemplate &&
        templateId &&
        version?.trim() &&
        release &&
        schema &&
        releaseReady
        ? {
            principalId,
            orgId,
            mode,
            templateId,
            version,
            releaseId: release.releaseId,
            releaseGeneration: release.releaseGeneration,
            candidateHash: release.candidateHash,
          }
        : undefined,
    );
    setConflict(false);
    resetCreate();
  }, [
    at,
    principalId,
    orgId,
    selectedTemplate,
    templateId,
    version,
    release,
    schema,
    releaseReady,
    mode,
    setReviewed,
    setConflict,
    resetCreate,
  ]);
  useEffect(() => {
    // A missing release while access or the eligible list is being revalidated is not a
    // confirmed change. Keep the review until the fresh result can be compared.
    if (scope.isLoading || !sessionReady || (eligible.isFetching && !eligible.isFetchingNextPage))
      return;
    if (
      at === 'review' &&
      reviewed &&
      (reviewed.principalId !== principalId ||
        reviewed.orgId !== orgId ||
        reviewed.mode !== mode ||
        reviewed.templateId !== templateId ||
        reviewed.version !== version ||
        reviewed.releaseId !== release?.releaseId ||
        reviewed.releaseGeneration !== release?.releaseGeneration ||
        reviewed.candidateHash !== release?.candidateHash)
    )
      setReviewed(undefined);
  }, [
    at,
    reviewed,
    scope.isLoading,
    sessionReady,
    setReviewed,
    eligible.isFetching,
    eligible.isFetchingNextPage,
    principalId,
    orgId,
    mode,
    templateId,
    version,
    release,
  ]);

  // Leaving a step drops what Next on it would have committed.
  const stepKey = useRef(at);
  useEffect(() => {
    if (stepKey.current !== at) setPendingTemplateCommit(undefined);
    stepKey.current = at;
  }, [at, setPendingTemplateCommit]);

  // A tile double-clicked before its release arrived advances once it has.
  useEffect(() => {
    if (!pendingTemplateCommit || at !== 'template' || pendingTemplateCommit !== templateId) return;
    if (!release) return;
    setPendingTemplateCommit(undefined);
    jump('details');
  }, [pendingTemplateCommit, at, templateId, release, setPendingTemplateCommit, jump]);

  // A deep link to a template lands on Details once its release is known.
  const [linked, setLinked] = useState(false);
  const first = wizard.index === 0;
  const landing =
    !linked && Boolean(orgId && linkTemplate && selectedTemplate?.id === linkTemplate);
  useEffect(() => {
    if (!landing) return;
    setLinked(true);
    if (first) jump('details');
  }, [landing, first, jump]);

  // The render before the jump would draw the tiles it is about to leave.
  return { wizard, notReady, settling: landing && first };
}
