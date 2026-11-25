import { useEffect, useId, useRef, useState } from 'react';
import { errorMessage, isApiError } from '../../lib/errors.ts';
import { attentionLine, useServerFields } from '../form.tsx';
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
  /** Blocking problems per step, a pure function of the draft: field to message. */
  errors: Partial<Record<Id, Partial<Record<string, string>> | undefined>>;
  /** Why Next is off, four words or fewer with a period ("Name the key."). Falls back to the count. */
  hints?: Partial<Record<Id, string>>;
  /** Server field to the step that fixes it. */
  fieldStep: Partial<Record<string, Id>>;
  /** The last step's Next. Throw the ApiError; the hook maps it. */
  onFinish: () => Promise<unknown> | unknown;
  /** Create is linear and ends in a Review; edit reaches every step and ends in Save. */
  mode?: 'create' | 'edit';
  /** Dialogs pass `open`: a close resets the wizard. */
  open?: boolean;
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
  };
  /** The step changed `key` times; WizardStep animates from `direction`. */
  motion: { key: number; direction: 1 | -1 };
  reset(): void;
}

const has = (found: Partial<Record<string, string>> | undefined) =>
  Boolean(found && Object.values(found).some(Boolean));

/**
 * The step model of a wizard: where it is, what is done, what blocks Next, and where a server's
 * field errors land. No JSX; WizardDialog and the page Wizard draw it.
 */
export function useWizard<Id extends string>(options: WizardOptions<Id>): WizardModel<Id> {
  const { steps, errors, hints, fieldStep, onFinish, mode = 'create', open } = options;
  const edit = mode === 'edit';
  const formId = useId();
  const [index, setIndex] = useState(0);
  const [reached, setReached] = useState(0);
  const [passed, setPassed] = useState<ReadonlySet<Id>>(new Set());
  const [shown, setShown] = useState<ReadonlySet<Id>>(new Set());
  const [formError, setFormError] = useState<string>();
  const [finishing, setFinishing] = useState(false);
  const [motion, setMotion] = useState<{ key: number; direction: 1 | -1 }>({
    key: 0,
    direction: 1,
  });
  const server = useServerFields();

  const current = steps[index] ?? steps[0];
  const bad = (id: Id) => has(errors[id]);
  const serverSteps = new Set<string>();
  for (const field of Object.keys(server.fields)) {
    const at = fieldStep[field];
    if (at) serverSteps.add(at);
  }
  const lastIndex = steps.reduce((at, s, i) => (s.skip ? at : i), 0);
  const reviewIndex = steps.findIndex((s) => s.id === 'review');
  const stateOf = (i: number): WizardStepState => {
    const s = steps[i];
    if (!s) return 'todo';
    if (s.skip && i !== index) return 'skipped';
    if (i === index) return 'current';
    const visited = edit || passed.has(s.id);
    if (serverSteps.has(s.id) || (visited && bad(s.id))) return 'invalid';
    return visited ? 'done' : 'todo';
  };
  const views = steps.map((s, i) => ({ ...s, state: stateOf(i) }));
  const firstBad = steps.findIndex((s) => bad(s.id));
  const blocked = edit ? firstBad >= 0 : current ? bad(current.id) : false;
  const hintStep = edit ? steps[firstBad] : current;
  const count = hintStep ? Object.values(errors[hintStep.id] ?? {}).filter(Boolean).length : 0;
  const hint =
    blocked && hintStep ? (hints?.[hintStep.id] ?? attentionLine(Math.max(count, 1))) : undefined;
  const last = edit || index >= lastIndex;
  const laterDone =
    reviewIndex > index &&
    views.slice(index + 1, reviewIndex).every((s) => s.skip || s.state === 'done');
  const primary: WizardModel<Id>['primary'] = last
    ? 'finish'
    : reviewIndex > index && reached >= reviewIndex && !blocked && laterDone
      ? 'review'
      : 'next';

  function move(to: number) {
    const direction = to >= index ? 1 : -1;
    setMotion((m) => ({ key: m.key + 1, direction }));
    setFormError(undefined);
    setReached((r) => Math.max(r, to));
    setIndex(to);
  }

  function hop(from: number, step: 1 | -1) {
    let at = from + step;
    while (steps[at]?.skip && at > 0 && at < steps.length - 1) at += step;
    return Math.min(Math.max(at, 0), steps.length - 1);
  }

  function pass() {
    if (current) setPassed((p) => new Set(p).add(current.id));
  }

  function showErrors(id: Id) {
    setShown((s) => new Set(s).add(id));
  }

  function go(to: number | Id) {
    const at = typeof to === 'number' ? to : steps.findIndex((s) => s.id === to);
    const target = steps[at];
    if (!target || at === index || target.skip) return;
    if (!edit && at > index && stateOf(at) !== 'done' && stateOf(at) !== 'invalid') return;
    move(at);
  }

  function refuse() {
    const at = edit ? firstBad : index;
    const step = steps[at];
    if (!step) return;
    showErrors(step.id);
    if (at !== index) move(at);
  }

  function fail(cause: unknown): SaveResult {
    if (!isApiError(cause) || Object.keys(cause.fields).length === 0) {
      setFormError(errorMessage(cause));
      return 'failed';
    }
    server.set(cause.fields);
    const fields = Object.keys(cause.fields);
    const owner = (field: string) => {
      const id = fieldStep[field];
      return id ? steps.findIndex((s) => s.id === id && !s.skip) : -1;
    };
    const owners = fields.map(owner).filter((at) => at >= 0);
    const to = owners.length ? Math.min(...owners) : -1;
    if (to >= 0 && to !== index) move(to);
    // A field no step owns would otherwise show nowhere.
    const orphan = fields.find((f) => owner(f) < 0);
    if (orphan) setFormError(cause.fields[orphan]);
    return to >= 0 ? 'refused' : 'failed';
  }

  async function finish(): Promise<SaveResult> {
    setFormError(undefined);
    server.reset();
    setFinishing(true);
    try {
      await onFinish();
      return 'saved';
    } catch (cause) {
      return fail(cause);
    } finally {
      setFinishing(false);
    }
  }

  function onValid() {
    if (last) return finish();
    pass();
    move(primary === 'review' ? reviewIndex : hop(index, 1));
    return undefined;
  }

  function onInvalid() {
    refuse();
  }

  function reset() {
    setIndex(0);
    setReached(0);
    setPassed(new Set());
    setShown(new Set());
    setFormError(undefined);
    setFinishing(false);
    setMotion((m) => ({ key: m.key + 1, direction: -1 }));
    server.reset();
  }
  const resetRef = useRef(reset);
  resetRef.current = reset;
  useEffect(() => {
    if (open === false) resetRef.current();
  }, [open]);

  const visible: Record<string, string | undefined> = { ...server.fields };
  for (const s of steps) {
    if (shown.has(s.id) && (edit || s.id === current?.id)) Object.assign(visible, errors[s.id]);
  }

  return {
    steps: views,
    mode,
    index,
    id: (current?.id ?? '') as Id,
    first: index === 0,
    last,
    go,
    next() {
      const form = typeof document === 'undefined' ? null : document.getElementById(formId);
      if (form instanceof HTMLFormElement) form.requestSubmit();
      else if (blocked) refuse();
      else void onValid();
    },
    back() {
      if (index > 0) move(hop(index, -1));
    },
    blocked,
    hint,
    errors: visible,
    formError,
    clearServer: server.clear,
    primary,
    finishing,
    form: { id: formId, invalid: blocked, blockedHint: hint, onInvalid, onValid },
    motion,
    reset,
  };
}
