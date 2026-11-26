import type { FormEvent } from 'react';
import type { SaveResult } from '../save-bar.tsx';

export interface WizardStepDef<Id extends string = string> {
  id: Id;
  /** Rail label: a noun, one or two words ("Basics", "Who gets in"). */
  title: string;
  /** The visible heading, an instruction of four words or fewer ("Name the key"). Without it the title is the heading, for screen readers only. */
  heading?: string;
  /** What was chosen, under a done step on the rail ("Box office sync", "3 scopes"). */
  summary?: string | undefined;
  /** Not needed this run because of an earlier choice: hopped by Next and Back, no Review section. */
  skip?: boolean;
}

export type WizardStepState = 'done' | 'current' | 'todo' | 'skipped' | 'invalid';

export interface WizardOptions<Id extends string> {
  /** Computed each render: summaries change with the draft. */
  steps: readonly WizardStepDef<Id>[];
  /**
   * Blocking problems per step, a pure function of the draft: field to message. A `wait` key is a
   * load in flight: it holds Next on its own step and never turns another step invalid.
   */
  errors: Partial<Record<Id, Partial<Record<string, string>> | undefined>>;
  /** Why Next is off, four words or fewer with a period ("Name the key."). Falls back to the count. */
  hints?: Partial<Record<Id, string>>;
  /** Server field to the step that fixes it. */
  fieldStep: Partial<Record<string, Id>>;
  /** The last step's Next. Throw the ApiError; the hook maps it. */
  onFinish: () => Promise<unknown> | unknown;
  /** Create is linear and ends in a Review; edit reaches every step and ends in Save. */
  mode?: 'create' | 'edit';
  /** Dialogs pass `open`: the wizard resets when it opens again. */
  open?: boolean;
  /** Edit mode: the draft differs from what was loaded. Save is blocked with "No changes." until it does. */
  dirty?: boolean;
}

/**
 * What the page `Wizard` takes from the model: spread it, then add `onCancel`, the labels (see
 * `primary`) and the stage. The Next button submits the form `formId` names.
 */
export interface WizardFrameProps {
  steps: readonly WizardStepDef[];
  /** One state per step: the rail shows done, invalid and skipped as the model derives them. */
  states: readonly WizardStepState[];
  current: number;
  onStep: (index: number) => void;
  skipped: readonly string[];
  onBack: (() => void) | undefined;
  formId: string;
  nextDisabled: boolean;
  nextHint: string | undefined;
  busy: boolean;
  /** One line at the foot of the step (a refused finish). */
  formError: string | undefined;
  /** A press on a blocked Next: submits the form, which shows the step's errors. */
  onBlocked: () => void;
}

export interface WizardModel<Id extends string = string> {
  steps: (WizardStepDef<Id> & { state: WizardStepState })[];
  mode: 'create' | 'edit';
  index: number;
  id: Id;
  first: boolean;
  /** No later step is left to do: Next finishes. */
  last: boolean;
  /** Create: a step that was passed, or any step behind. Edit: any step. */
  go(to: number | Id): void;
  /** Move there whatever the state of the steps between, marking those behind it done. For a choice that skips ahead (a deep link, a committed tile). */
  jump(to: number | Id): void;
  /** Same as pressing Next: a blocked step shows its errors instead. */
  next(): void;
  back(): void;
  blocked: boolean;
  /** Why the step is blocked, while it is. */
  hint: string | undefined;
  /** What the step's fields render: shown client errors, then the server's. */
  errors: Record<string, string | undefined>;
  /** One line at the foot of the step. */
  formError: string | undefined;
  /** Call from a field's onChange. */
  clearServer(field?: string): void;
  /** 'review' jumps back to Review when every step after this one is still done. */
  primary: 'next' | 'review' | 'finish';
  finishing: boolean;
  form: {
    id: string;
    invalid: boolean;
    blockedHint: string | undefined;
    onInvalid(): void;
    onValid(): Promise<SaveResult | undefined> | undefined;
    /** Typing clears the server's errors on the fields this step owns. */
    onInput(event: FormEvent<HTMLFormElement>): void;
  };
  /** Spread on the page `Wizard`. */
  frame: WizardFrameProps;
  /** The step changed `key` times; WizardStep animates from `direction`. */
  motion: { key: number; direction: 1 | -1 };
  reset(): void;
}

/** What the rail reads: the page `Wizard` builds this from its props. */
export type WizardRail = Pick<WizardModel, 'steps' | 'index' | 'mode' | 'go'>;

/** What a step body reads. */
export type WizardStepView = Pick<
  WizardModel,
  'steps' | 'index' | 'id' | 'last' | 'finishing' | 'motion' | 'formError'
>;
