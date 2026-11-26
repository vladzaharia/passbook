import type { InfiniteData, UseInfiniteQueryResult, UseQueryResult } from '@tanstack/react-query';
import type { ComponentProps, Dispatch, SetStateAction } from 'react';
import type { z } from 'zod';
import type { OrgMembership } from '@/shared/contracts/org-membership.ts';
import type {
  EligibleTemplate,
  EligibleTemplateList,
} from '@/shared/contracts/template-releases.ts';
import type { TemplateVersionDetailSchema } from '@/shared/contracts/templates.ts';
import type { UnsavedChangesDialog, WizardModel } from '../../ui/index.ts';
import type { LivePreviewState } from './new-pass-preview.tsx';
import type { OrgOption } from './new-pass-steps.tsx';
import type { FormValues } from './schema-form/index.ts';

export type StepId = 'org' | 'template' | 'details' | 'holder' | 'review';
type Setter<T> = Dispatch<SetStateAction<T>>;

export interface NewPassScope {
  mode: 'live' | 'test';
  scope: {
    orgId: string | undefined;
    membership: OrgMembership | undefined;
    memberships: OrgMembership[];
    setOrgId: (id: string | undefined) => void;
    isLoading: boolean;
    isError: boolean;
    error: unknown;
  };
  orgs: { isPending: boolean; error: unknown };
  grantsReady: boolean;
  operable: Set<string>;
  active: OrgOption[];
  selectedOrg: string | undefined;
  setSelectedOrg: Setter<string | undefined>;
  pendingChoice: string | undefined;
  setPendingChoice: Setter<string | undefined>;
  orgId: string | undefined;
  canReadPasses: boolean;
  canReadTemplates: boolean;
  /** Cached only to render an already open draft while this same scope is revalidated. */
  displayOrgId: string | undefined;
  displayCanReadTemplates: boolean;
  displayOrg: OrgOption | undefined;
  displayOrgName: string | null | undefined;
  org: OrgOption | undefined;
}

type IssuableTemplate = EligibleTemplate & {
  id: string;
  orgId: string | null;
  orgName: string | null;
};

export interface NewPassRelease {
  eligible: UseInfiniteQueryResult<InfiniteData<EligibleTemplateList>, Error>;
  usable: IssuableTemplate[];
  selectedTemplate: IssuableTemplate | undefined;
  release: IssuableTemplate | undefined;
  version: string | undefined;
  releasedVersion: UseQueryResult<z.infer<typeof TemplateVersionDetailSchema>, Error>;
  manifest: Record<string, unknown> | undefined;
  schema: unknown;
}

export interface ReviewedPass {
  principalId: string;
  orgId: string;
  mode: 'live' | 'test';
  templateId: string;
  version: string;
  releaseId: string;
  releaseGeneration: number;
  candidateHash: string;
}

interface CreatedPass {
  id: string;
  orgId: string;
  principalId: string;
}

export interface NewPassDraft {
  input: FormValues;
  setInput: Setter<FormValues>;
  email: string;
  setEmail: Setter<string>;
  send: boolean;
  setSend: Setter<boolean>;
  validEmail: boolean;
  inputErrors: Partial<Record<string, string>>;
  reviewed: ReviewedPass | undefined;
  setReviewed: Setter<ReviewedPass | undefined>;
  /** The organization was picked on the wizard's first step, so that step stays in its rail. */
  orgChosen: boolean;
  setConflict: Setter<boolean>;
  releaseReady: boolean;
  readyToCreate: boolean;
  created: CreatedPass | undefined;
  setCreated: Setter<CreatedPass | undefined>;
  createdId: string | undefined;
  guard: ComponentProps<typeof UnsavedChangesDialog>['blocker'];
  firstOfOrg: boolean;
  chooseOrg: (id: string) => void;
  chooseTemplate: (id: string) => void;
}

interface DraftPayload {
  orgId: string | undefined;
  templateId: string | undefined;
  mode: 'live' | 'test';
  templateVersion: string | undefined;
  releaseId: string | undefined;
  releaseGeneration: number | undefined;
  input: FormValues;
  holderEmail?: string;
  sendEmail: boolean;
}

interface CreateIntent {
  payload: DraftPayload & {
    orgId: string;
    templateId: string;
    templateVersion: string;
    releaseId: string;
    releaseGeneration: number;
  };
  principalId: string;
  firstOfOrg: boolean;
}

type CreateMutation = {
  isPending: boolean;
  reset: () => void;
  mutateAsync: (intent: CreateIntent) => Promise<unknown>;
} & ({ isError: true; error: Error } | { isError: false; error: Error | null });

export interface NewPassCreation {
  payload: DraftPayload;
  create: CreateMutation;
  onCancel: () => void;
}

export interface NewPassWizardModel {
  principalId: string | undefined;
  sessionReady: boolean;
  templateId: string | undefined;
  setPendingTemplateCommit: Setter<string | undefined>;
  wizard: WizardModel<StepId>;
  access: NewPassScope;
  releaseData: NewPassRelease;
  draft: NewPassDraft;
  creation: NewPassCreation;
  /** Field errors the step shows: the wizard's shown client errors, then the server's. */
  errors: Partial<Record<string, string>>;
  /** Server errors on the details fields, by the schema's own keys. */
  fieldErrors: Record<string, string> | undefined;
  emailError: string | undefined;
  hiddenKeys: Set<string>;
  /** The Create step's own button label. */
  finishLabel: string;
  /** Why Create is off, in a line the review card shows. */
  notReady: string | undefined;
  /** A deep link is about to land on Details: the step it leaves is not drawn. */
  settling: boolean;
  live: LivePreviewState;
  name: string | undefined;
}
